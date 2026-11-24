package community

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
	"github.com/marlstudio/hull/backend/internal/store/storetest"
)

func put(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, mode)
}

// gameDir makes a folder with things that must ship and things that must not.
func gameDir(t *testing.T) string {
	d := t.TempDir()
	put(t, filepath.Join(d, "hull.json"), `{"id":"ironleaf","title":"Ironleaf","note":"A sword game","version":"0.1.0"}`, 0o644)
	put(t, filepath.Join(d, "src/main.ts"), "export {}", 0o644)
	put(t, filepath.Join(d, "tools/run.sh"), "#!/bin/sh", 0o755)
	put(t, filepath.Join(d, "config/a.json"), "{}", 0o644)
	put(t, filepath.Join(d, "node_modules/dep/index.js"), "x", 0o644)
	put(t, filepath.Join(d, "src/node_modules/dep/index.js"), "x", 0o644)
	put(t, filepath.Join(d, ".hull/history.db"), "x", 0o644)
	put(t, filepath.Join(d, "dist/game.js"), "x", 0o644)
	put(t, filepath.Join(d, ".git/HEAD"), "x", 0o644)
	put(t, filepath.Join(d, ".env"), "SECRET=1", 0o600)
	put(t, filepath.Join(d, ".env.local"), "SECRET=2", 0o600)
	put(t, filepath.Join(d, "config/.env.production"), "SECRET=3", 0o600)
	put(t, filepath.Join(d, "cover.jpg"), "JPEGDATA", 0o644)
	if err := os.Symlink("/etc/passwd", filepath.Join(d, "link")); err != nil {
		t.Fatal(err)
	}
	return d
}

func openStore(t *testing.T) *store.Store {
	st := storetest.Open(t)
	return st
}

type entry struct {
	mode int64
	body string
}

func readArchive(t *testing.T, path string) map[string]entry {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string]entry{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		out[h.Name] = entry{h.Mode, string(b)}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
			t.Errorf("%s: unexpected entry type %c", h.Name, h.Typeflag)
		}
	}
	return out
}

func TestPublishArchiveContents(t *testing.T) {
	data, dir, st := t.TempDir(), gameDir(t), openStore(t)
	res, err := Publish(st, Options{DataDir: data, Dir: dir, Now: time.Unix(1700000000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "ironleaf" || res.Version != "0.1.0" || res.Title != "Ironleaf" || res.CoverMime != "image/jpeg" {
		t.Fatalf("result %+v", res)
	}
	arc := ArchivePath(data, "ironleaf", "0.1.0")
	got := readArchive(t, arc)
	var names []string
	for n := range got {
		names = append(names, n)
	}
	sort.Strings(names)
	want := []string{"config/", "config/a.json", "hull.json", "src/", "src/main.ts", "tools/", "tools/run.sh"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("archive has %v, want %v", names, want)
	}
	for n := range got {
		if strings.HasPrefix(n, "/") || strings.Contains(n, "..") {
			t.Errorf("path %q is not relative", n)
		}
	}
	if got["tools/run.sh"].mode != 0o755 || got["src/main.ts"].mode != 0o644 {
		t.Errorf("modes not kept: %o %o", got["tools/run.sh"].mode, got["src/main.ts"].mode)
	}
	b, _ := os.ReadFile(arc)
	sum := sha256.Sum256(b)
	if res.SHA256 != hex.EncodeToString(sum[:]) || res.Size != int64(len(b)) {
		t.Errorf("sha/size mismatch: %s %d", res.SHA256, res.Size)
	}
	cover, err := os.ReadFile(CoverPath(data, "ironleaf", "0.1.0", "image/jpeg"))
	if err != nil || string(cover) != "JPEGDATA" {
		t.Errorf("cover not stored: %v %q", err, cover)
	}
	row, err := st.CommunityVersion("ironleaf", "0.1.0")
	if err != nil || row.SHA256 != res.SHA256 || row.Title != "Ironleaf" || row.Note != "A sword game" || row.PublishedAt.Unix() != 1700000000 {
		t.Errorf("row %+v %v", row, err)
	}
}

func TestPublishFlagsOverrideManifestAndCoverPreference(t *testing.T) {
	data, dir, st := t.TempDir(), gameDir(t), openStore(t)
	put(t, filepath.Join(dir, "cover.png"), "PNG", 0o644)
	put(t, filepath.Join(dir, "cover.webp"), "WEBP", 0o644)
	res, err := Publish(st, Options{DataDir: data, Dir: dir, ID: "other-id", Version: "2.0.0", Note: "flag note"})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "other-id" || res.Version != "2.0.0" || res.Note != "flag note" || res.CoverMime != "image/webp" {
		t.Fatalf("%+v", res)
	}
	if _, ok := readArchive(t, ArchivePath(data, "other-id", "2.0.0"))["cover.webp"]; ok {
		t.Error("cover files must not be in the archive")
	}
}

func TestPublishNoManifest(t *testing.T) {
	d := t.TempDir()
	put(t, filepath.Join(d, "a.txt"), "a", 0o644)
	st := openStore(t)
	if _, err := Publish(st, Options{DataDir: t.TempDir(), Dir: d}); err == nil || !strings.Contains(err.Error(), "no id") {
		t.Errorf("want no id error, got %v", err)
	}
	if _, err := Publish(st, Options{DataDir: t.TempDir(), Dir: d, ID: "x"}); err == nil || !strings.Contains(err.Error(), "no version") {
		t.Errorf("want no version error, got %v", err)
	}
	res, err := Publish(st, Options{DataDir: t.TempDir(), Dir: d, ID: "x", Version: "1.0.0"})
	if err != nil || res.Title != "x" || res.CoverMime != "" {
		t.Errorf("%+v %v", res, err)
	}
}

func TestVersionRules(t *testing.T) {
	data, dir, st := t.TempDir(), gameDir(t), openStore(t)
	pub := func(v string) error {
		_, err := Publish(st, Options{DataDir: data, Dir: dir, Version: v})
		return err
	}
	for _, v := range []string{"1.9.0", "1.10.0"} {
		if err := pub(v); err != nil {
			t.Fatalf("%s: %v", v, err)
		}
	}
	if err := pub("1.10.0"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate: %v", err)
	}
	if err := pub("1.9.5"); err == nil || !strings.Contains(err.Error(), "not greater than the latest, 1.10.0") {
		t.Errorf("older: %v", err)
	}
	for _, bad := range []string{"1.0", "v1.0.0", "1.0.0-beta", "01.0.0", "1.a.0", "1..0", "-1.0.0"} {
		if err := pub(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	rows, _ := st.CommunityVersions("ironleaf")
	SortNewestFirst(rows)
	if len(rows) != 2 || rows[0].Version != "1.10.0" || rows[1].Version != "1.9.0" {
		t.Errorf("order %+v", rows)
	}
	// A refused publish leaves no stray folder behind.
	entries, _ := os.ReadDir(filepath.Join(data, "community", "ironleaf"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			t.Errorf("leftover %s", e.Name())
		}
	}
	if a, b := (Version{1, 10, 0}), (Version{1, 9, 0}); a.Compare(b) != 1 || b.Compare(a) != -1 || a.Compare(a) != 0 {
		t.Error("compare")
	}
}

func TestInvalidID(t *testing.T) {
	for _, id := range []string{"", "A", "a_b", "a/b", "..", "a b", strings.Repeat("a", 41)} {
		if ValidID(id) {
			t.Errorf("%q valid", id)
		}
	}
	for _, id := range []string{"a", "a-1", strings.Repeat("a", 40)} {
		if !ValidID(id) {
			t.Errorf("%q invalid", id)
		}
	}
}

func TestRemove(t *testing.T) {
	data, dir, st := t.TempDir(), gameDir(t), openStore(t)
	if _, err := Publish(st, Options{DataDir: data, Dir: dir}); err != nil {
		t.Fatal(err)
	}
	if err := Remove(st, data, "ironleaf", "0.1.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(VersionDir(data, "ironleaf", "0.1.0")); !os.IsNotExist(err) {
		t.Errorf("files remain: %v", err)
	}
	if _, err := st.CommunityVersion("ironleaf", "0.1.0"); err != store.ErrNotFound {
		t.Errorf("row remains: %v", err)
	}
	if err := Remove(st, data, "ironleaf", "0.1.0"); err == nil || !strings.Contains(err.Error(), "not in the catalog") {
		t.Errorf("second remove: %v", err)
	}
	if err := Remove(st, data, "../x", "0.1.0"); err == nil {
		t.Error("bad id accepted")
	}
	// The version can be published again after removal.
	if _, err := Publish(st, Options{DataDir: data, Dir: dir}); err != nil {
		t.Errorf("republish: %v", err)
	}
}

func TestDataDirInsideGameIsSkipped(t *testing.T) {
	dir, st := gameDir(t), openStore(t)
	data := filepath.Join(dir, "data")
	if _, err := Publish(st, Options{DataDir: data, Dir: dir, Version: "1.0.0"}); err != nil {
		t.Fatal(err)
	}
	for n := range readArchive(t, ArchivePath(data, "ironleaf", "1.0.0")) {
		if strings.HasPrefix(n, "data/community") {
			t.Errorf("catalog packed into itself: %s", n)
		}
	}
}
