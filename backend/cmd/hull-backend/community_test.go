package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommunityCLI(t *testing.T) {
	data, game := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(game, "hull.json"), []byte(`{"id":"g1","title":"Game One","version":"1.0.0"}`), 0o644)
	os.WriteFile(filepath.Join(game, "a.txt"), []byte("a"), 0o644)
	env := func(k string) string {
		if k == "DATA_DIR" {
			return data
		}
		return ""
	}
	run := func(args ...string) (string, error) {
		var b bytes.Buffer
		err := runCommunity(args, env, &b)
		return b.String(), err
	}
	out, err := run("publish", "--dir", game, "--note", "hi")
	if err != nil || !strings.Contains(out, "id: g1") || !strings.Contains(out, "version: 1.0.0") || !strings.Contains(out, "sha256: ") || !strings.Contains(out, "size: ") {
		t.Fatalf("publish: %q %v", out, err)
	}
	if _, err := run("publish", "--dir", game); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("republish: %v", err)
	}
	if _, err := run("publish", "--dir", game, "--version", "1.1.0"); err != nil {
		t.Fatal(err)
	}
	out, err = run("list")
	if err != nil || !strings.Contains(out, "g1  Game One") || strings.Index(out, "1.1.0") > strings.Index(out, "1.0.0") {
		t.Errorf("list: %q %v", out, err)
	}
	if _, err := run("remove", "--id", "g1"); err == nil {
		t.Error("remove without version accepted")
	}
	if out, err = run("remove", "--id", "g1", "--version", "1.1.0"); err != nil || !strings.Contains(out, "removed g1 1.1.0") {
		t.Errorf("remove: %q %v", out, err)
	}
	if _, err := run("bogus"); err == nil {
		t.Error("unknown command accepted")
	}
	if _, err := run("publish"); err == nil || !strings.Contains(err.Error(), "--dir is required") {
		t.Errorf("no dir: %v", err)
	}
}
