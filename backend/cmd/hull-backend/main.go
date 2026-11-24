// Command hull-backend serves Hull accounts, app sign-in and the AI proxy.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/server"
)

func main() {
	// "community ..." runs a publishing command and exits; with no subcommand the binary serves as before.
	if len(os.Args) > 1 && os.Args[1] == "community" {
		if err := runCommunity(os.Args[2:], os.Getenv, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "hull-backend:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := runMigrate(os.Getenv, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "hull-backend:", err)
			os.Exit(1)
		}
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("hull-backend stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	st, err := openStore(context.Background(), cfg)
	if err != nil {
		return err
	}
	defer st.Close()
	log.Info("database ready", "kind", st.Kind(), "where", st.Where())

	if cfg.AnthropicKey == "" {
		log.Warn("ANTHROPIC_API_KEY is not set: sign-in works, but the AI routes answer 503")
	}
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           server.New(cfg, st, log).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second, // AI routes extend this per request for large bodies
		WriteTimeout:      30 * time.Second, // AI routes lift this per request so streams can run
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			if err := st.Purge(time.Now()); err != nil {
				log.Error("purging expired rows", "err", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()

	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Info("hull-backend listening", "addr", cfg.Addr, "public_url", cfg.PublicURL, "signup", cfg.AllowSignup, "ai_key_set", cfg.AnthropicKey != "")
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
