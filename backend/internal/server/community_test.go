package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/marlstudio/hull/backend/internal/community"
	"github.com/marlstudio/hull/backend/internal/config"
)

// publishGame makes a small game folder and publishes it through the real publisher.
func publishGame(t *testing.T, e *env, data, id, title, version string, cover string) community.Result {
	t.Helper()
	d := t.TempDir()
	if err := os.WriteFile(filepath.Join(d, "main.ts"), []byte("// "+id+version), 0o644); err != nil {
		t.Fatal(err)
	}
	if cover != "" {
		if err := os.WriteFile(filepath.Join(d, cover), []byte("IMG-"+id+version), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := community.Publish(e.st, community.Options{DataDir: data, Dir: d, ID: id, Version: version, Title: title, Note: "note " + title, Now: time.Unix(1700000000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func communityEnv(t *testing.T) (*env, string) {
	data := t.TempDir()
	e := newEnv(t, func(c *config.Config) { c.DataDir = data; c.PublicURL = "https://games.example.com" })
	return e, data
}

func get(t *testing.T, e *env, path string, hdr ...string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", e.ts.URL+path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func TestCommunityListShapeSortAndURLs(t *testing.T) {
	e, data := communityEnv(t)
	publishGame(t, e, data, "zeta", "zeta Game", "1.0.0", "")
	publishGame(t, e, data, "alpha", "Beta Title", "1.2.0", "")
	publishGame(t, e, data, "alpha", "Beta Title", "1.9.0", "cover.png")
	last := publishGame(t, e, data, "alpha", "Beta Title", "1.10.0", "cover.webp")
	publishGame(t, e, data, "mid", "Alpha Title", "0.0.1", "")

	resp, body := get(t, e, "/api/community")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json" || !strings.Contains(resp.Header.Get("Cache-Control"), "public") {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	var out struct {
		Games []map[string]any `json:"games"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err, string(body))
	}
	var titles []string
	for _, g := range out.Games {
		titles = append(titles, g["title"].(string))
	}
	if strings.Join(titles, "|") != "Alpha Title|Beta Title|zeta Game" {
		t.Fatalf("sort: %v", titles)
	}
	beta := out.Games[1]
	for _, k := range []string{"id", "title", "note", "version", "published_at", "size", "sha256", "cover_url", "download_url", "versions"} {
		if _, ok := beta[k]; !ok {
			t.Errorf("missing key %s", k)
		}
	}
	if beta["version"] != "1.10.0" || beta["sha256"] != last.SHA256 || int64(beta["size"].(float64)) != last.Size {
		t.Errorf("newest fields: %v", beta)
	}
	vs := beta["versions"].([]any)
	if len(vs) != 3 || vs[0] != "1.10.0" || vs[1] != "1.9.0" || vs[2] != "1.2.0" {
		t.Errorf("versions %v", vs)
	}
	if beta["download_url"] != "https://games.example.com/api/community/alpha/1.10.0/game.tar.gz" ||
		beta["cover_url"] != "https://games.example.com/api/community/alpha/1.10.0/cover" {
		t.Errorf("urls %v %v", beta["download_url"], beta["cover_url"])
	}
	if beta["published_at"] != time.Unix(1700000000, 0).UTC().Format(time.RFC3339) {
		t.Errorf("published_at %v", beta["published_at"])
	}
	if out.Games[0]["cover_url"] != nil {
		t.Errorf("cover_url should be null: %v", out.Games[0]["cover_url"])
	}
}

func TestCommunityListEmpty(t *testing.T) {
	e, _ := communityEnv(t)
	_, body := get(t, e, "/api/community")
	if strings.TrimSpace(string(body)) != `{"games":[]}` {
		t.Errorf("%s", body)
	}
}

func TestCommunityDownloadAndCovers(t *testing.T) {
	e, data := communityEnv(t)
	old := publishGame(t, e, data, "game", "Game", "1.0.0", "cover.png")
	cur := publishGame(t, e, data, "game", "Game", "1.1.0", "cover.jpg")

	resp, body := get(t, e, "/api/community/game/1.1.0/game.tar.gz")
	sum := sha256.Sum256(body)
	if resp.StatusCode != 200 || hex.EncodeToString(sum[:]) != cur.SHA256 {
		t.Fatalf("download %d sha mismatch", resp.StatusCode)
	}
	h := resp.Header
	if h.Get("Content-Type") != "application/gzip" || h.Get("X-Hull-Sha256") != cur.SHA256 || h.Get("ETag") != `"`+cur.SHA256+`"` ||
		resp.ContentLength != cur.Size || !strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Errorf("headers %v len %d", h, resp.ContentLength)
	}
	resp, _ = get(t, e, "/api/community/game/1.1.0/game.tar.gz", "If-None-Match", `"`+cur.SHA256+`"`)
	if resp.StatusCode != 304 {
		t.Errorf("etag revalidation: %d", resp.StatusCode)
	}

	resp, body = get(t, e, "/api/community/game/cover")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/jpeg" || string(body) != "IMG-game1.1.0" ||
		resp.Header.Get("Cache-Control") != "public, max-age=3600" {
		t.Errorf("latest cover %d %v %q", resp.StatusCode, resp.Header, body)
	}
	resp, body = get(t, e, "/api/community/game/1.0.0/cover")
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || string(body) != "IMG-game1.0.0" {
		t.Errorf("version cover %d %v %q", resp.StatusCode, resp.Header, body)
	}
	resp, body = get(t, e, "/api/community/game/1.0.0/game.tar.gz")
	sum = sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != old.SHA256 {
		t.Error("old version bytes differ")
	}
}

func TestCommunity404sAndTraversal(t *testing.T) {
	e, data := communityEnv(t)
	publishGame(t, e, data, "game", "Game", "1.0.0", "")
	publishGame(t, e, data, "covered", "Covered", "1.0.0", "cover.jpg")
	publishGame(t, e, data, "covered", "Covered", "1.1.0", "") // latest has no cover: 404 even though 1.0.0 had one
	os.WriteFile(filepath.Join(data, "secret.txt"), []byte("secret"), 0o600)

	for _, p := range []string{
		"/api/community/nope/cover",
		"/api/community/game/cover", // no cover
		"/api/community/covered/cover",
		"/api/community/game/9.9.9/cover",
		"/api/community/game/9.9.9/game.tar.gz",
		"/api/community/nope/1.0.0/game.tar.gz",
		"/api/community/game/1.0/game.tar.gz",
		"/api/community/game/01.0.0/game.tar.gz",
		"/api/community/Game/1.0.0/game.tar.gz",
		"/api/community/../game.tar.gz",
		"/api/community/%2e%2e/1.0.0/game.tar.gz",
		"/api/community/game/%2e%2e/game.tar.gz",
		"/api/community/game/..%2f..%2fsecret.txt/cover",
		"/api/community/..%2f/1.0.0/cover",
		"/api/community/game/1.0.0%2f..%2f..%2f..%2fsecret.txt/cover",
		"/api/community/game/1.0.0/game.tar.gz/extra",
	} {
		resp, body := get(t, e, p)
		if resp.StatusCode != 404 && resp.StatusCode != 301 && resp.StatusCode != 400 {
			t.Errorf("%s: status %d", p, resp.StatusCode)
		}
		if strings.Contains(string(body), "secret") && !strings.Contains(string(body), "not found") {
			t.Errorf("%s leaked", p)
		}
	}
	// Only GET is served.
	resp, err := http.Post(e.ts.URL+"/api/community", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", resp.StatusCode)
	}
}

func TestCommunityRateLimit(t *testing.T) {
	e, _ := communityEnv(t)
	limited := false
	for i := 0; i < communityRate+10; i++ {
		resp, _ := get(t, e, "/api/community")
		if resp.StatusCode == 429 {
			limited = true
			if resp.Header.Get("Retry-After") == "" {
				t.Error("no Retry-After")
			}
			break
		}
	}
	if !limited {
		t.Error("never limited")
	}
}
