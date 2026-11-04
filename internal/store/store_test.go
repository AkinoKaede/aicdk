package store

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestClaimIsDurableAndAtomic(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Claim("device", "token", "request", "code") == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatalf("concurrent claims accepted %d times", successes.Load())
	}
	signature := s.Hash("cookie", "device")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if signature != s.Hash("cookie", "device") {
		t.Fatal("cookie signing key changed after restart")
	}
	for _, input := range [][3]string{{"token", "new-id", "code"}, {"new-token", "request", "other-code"}, {"new-token", "new-id", "code"}} {
		if !errors.Is(s.Claim("device", input[0], input[1], input[2]), ErrAttemptExists) {
			t.Fatalf("replayed claim accepted: %v", input)
		}
	}
	if err := s.Claim("other-device", "token", "request", "code"); err != nil {
		t.Fatal("independent device should have an independent ledger")
	}
}

func TestBindingAndApproval(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	b := Binding{SystemID: "a", Origin: "https://one.test", CodeHash: "hash", Product: "gpt"}
	if err := s.Bind("device", "token", b); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Route("different-device", "token"); !errors.Is(err, ErrRouteMissing) {
		t.Fatal("route leaked to another device")
	}
	b.SystemID = "b"
	if !errors.Is(s.Bind("device", "token", b), ErrRouteConflict) {
		t.Fatal("route was overwritten")
	}
	if err := s.Approve("device", "token", "proof"); err != nil {
		t.Fatal(err)
	}
	if !s.Approved("device", "token", "proof") || s.Approved("device", "token", "wrong") {
		t.Fatal("approval mismatch")
	}
	if err := s.Approve("device", "token", ""); err != nil {
		t.Fatal(err)
	}
	if s.Approved("device", "token", "proof") {
		t.Fatal("approval was not revoked")
	}
}
