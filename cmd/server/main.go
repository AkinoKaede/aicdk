package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"cdk/internal/config"
	"cdk/internal/partner"
	"cdk/internal/server"
	"cdk/internal/store"
	"cdk/web"

	"github.com/gin-gonic/gin"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		healthcheck()
		return
	}
	if err := run(); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	c, err := config.Load()
	if err != nil {
		return err
	}
	db, err := store.Open(c.DataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	app, err := server.New(c, db, partner.New(), web.Assets())
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr: c.Listen, Handler: app, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 180 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- srv.ListenAndServe() }()
	slog.Info("CDK server ready", "listen", c.Listen, "systems", len(c.Systems))
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 165*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}

func healthcheck() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" || addr == ":8080" {
		addr = "127.0.0.1:8080"
	} else if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	client := &http.Client{Timeout: 3 * time.Second}
	r, err := client.Get("http://" + addr + "/healthz")
	if err != nil {
		os.Exit(1)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		os.Exit(1)
	}
}
