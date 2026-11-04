package store

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	bolt "go.etcd.io/bbolt"
)

var ErrAttemptExists = errors.New("redemption was already attempted")
var ErrRouteMissing = errors.New("redemption route not found")
var ErrRouteConflict = errors.New("redemption route changed")

type Binding struct {
	SystemID string `json:"system"`
	Origin   string `json:"origin"`
	CodeHash string `json:"code_hash"`
	Product  string `json:"product"`
}

type Store struct {
	db  *bolt.DB
	key []byte
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "cdk.db"), 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"meta", "routes", "approvals", "attempts", "code_attempts", "request_ids"} {
			if _, err := tx.CreateBucketIfNotExists([]byte(name)); err != nil {
				return err
			}
		}
		meta := tx.Bucket([]byte("meta"))
		key := meta.Get([]byte("signing_key"))
		if key == nil {
			key = make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return err
			}
			if err := meta.Put([]byte("signing_key"), key); err != nil {
				return err
			}
		}
		s.key = append([]byte(nil), key...)
		return nil
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Hash(parts ...string) string {
	mac := hmac.New(sha256.New, s.key)
	for _, part := range parts {
		mac.Write([]byte(part))
		mac.Write([]byte{0})
	}
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Store) Bind(device, token string, binding Binding) error {
	key := []byte(s.Hash("route", device, token))
	value, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("routes"))
		if previous := b.Get(key); previous != nil && string(previous) != string(value) {
			return ErrRouteConflict
		}
		return b.Put(key, value)
	})
}

func (s *Store) Route(device, token string) (Binding, error) {
	var binding Binding
	err := s.db.View(func(tx *bolt.Tx) error {
		value := tx.Bucket([]byte("routes")).Get([]byte(s.Hash("route", device, token)))
		if value == nil {
			return ErrRouteMissing
		}
		return json.Unmarshal(value, &binding)
	})
	return binding, err
}

// Both keys are committed and fsynced before any upstream side effect.
// An interrupted or uncertain request remains locked, including after restart.
func (s *Store) Claim(device, token, requestID, codeHash string) error {
	tokenKey := []byte(s.Hash("attempt", device, token))
	idKey := []byte(s.Hash("request_id", device, requestID))
	codeKey := []byte(s.Hash("code_attempt", device, codeHash))
	return s.db.Update(func(tx *bolt.Tx) error {
		attempts, ids := tx.Bucket([]byte("attempts")), tx.Bucket([]byte("request_ids"))
		codes := tx.Bucket([]byte("code_attempts"))
		if attempts.Get(tokenKey) != nil || ids.Get(idKey) != nil || codes.Get(codeKey) != nil {
			return ErrAttemptExists
		}
		if err := attempts.Put(tokenKey, idKey); err != nil {
			return err
		}
		if err := codes.Put(codeKey, tokenKey); err != nil {
			return err
		}
		return ids.Put(idKey, tokenKey)
	})
}

func (s *Store) Approve(device, token, proof string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("approvals"))
		key := []byte(s.Hash("approval", device, token))
		if proof == "" {
			return b.Delete(key)
		}
		return b.Put(key, []byte(s.Hash("proof", proof)))
	})
}

func (s *Store) Approved(device, token, proof string) bool {
	if proof == "" {
		return false
	}
	ok := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		actual := tx.Bucket([]byte("approvals")).Get([]byte(s.Hash("approval", device, token)))
		ok = hmac.Equal(actual, []byte(s.Hash("proof", proof)))
		return nil
	})
	return ok
}
