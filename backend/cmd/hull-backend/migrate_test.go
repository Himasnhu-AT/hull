package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/marlstudio/hull/backend/internal/store/storetest"
)

func TestMigrate(t *testing.T) {
	env := storetest.Env(t, map[string]string{"DATA_DIR": t.TempDir()})
	var first, second bytes.Buffer
	if err := runMigrate(env, &first); err != nil || !strings.Contains(first.String(), "created ") || !strings.Contains(first.String(), "waitlist") {
		t.Fatalf("first: %q %v", first.String(), err)
	}
	if err := runMigrate(env, &second); err != nil || !strings.Contains(second.String(), "already in place") || !strings.Contains(second.String(), "schema version: 1") {
		t.Fatalf("second: %q %v", second.String(), err)
	}
	for _, s := range []string{first.String(), second.String()} {
		if strings.Contains(s, "postgres://") {
			t.Fatalf("output shows a URL: %q", s)
		}
	}
}
