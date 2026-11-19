// Package community keeps the versioned catalog of community games: the files under DATA_DIR/community and
// the rows in the store. The publish, list and remove commands and the HTTP routes all go through it, so a
// version is either fully there (files and row) or not there.
package community

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/marlstudio/hull/backend/internal/store"
)

var idRe = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

// ValidID reports whether s may name a game. The same rule guards every path built from a request.
func ValidID(s string) bool { return idRe.MatchString(s) }

// Version is MAJOR.MINOR.PATCH, compared as numbers so 1.10.0 is newer than 1.9.0.
type Version struct{ Major, Minor, Patch int }

// ParseVersion accepts only three plain numbers ("1.2.3"); no prefix, no suffix, no leading zeros.
func ParseVersion(s string) (Version, error) {
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("version %q: want MAJOR.MINOR.PATCH, like 1.2.0", s)
	}
	var n [3]int
	for i, p := range parts {
		if p == "" || len(p) > 9 || (len(p) > 1 && p[0] == '0') {
			return Version{}, fmt.Errorf("version %q: %q is not a plain number", s, p)
		}
		v, err := strconv.Atoi(p)
		if err != nil || v < 0 {
			return Version{}, fmt.Errorf("version %q: %q is not a plain number", s, p)
		}
		n[i] = v
	}
	return Version{n[0], n[1], n[2]}, nil
}

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch) }

// Compare returns -1, 0 or 1.
func (v Version) Compare(o Version) int {
	for _, p := range [][2]int{{v.Major, o.Major}, {v.Minor, o.Minor}, {v.Patch, o.Patch}} {
		if p[0] != p[1] {
			if p[0] < p[1] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// SortNewestFirst orders rows of one game by version, highest first. Rows whose version does not parse
// (only possible if the database was edited by hand) go last.
func SortNewestFirst(vs []store.CommunityVersion) {
	sort.SliceStable(vs, func(i, j int) bool {
		a, ea := ParseVersion(vs[i].Version)
		b, eb := ParseVersion(vs[j].Version)
		if ea != nil || eb != nil {
			return ea == nil && eb != nil
		}
		return a.Compare(b) > 0
	})
}

// Cover files, in order of preference, with the content type each is served as.
var coverTypes = []struct{ ext, mime string }{
	{"webp", "image/webp"},
	{"jpg", "image/jpeg"},
	{"png", "image/png"},
}

// CoverExt gives the file extension for a stored cover content type, or "" when it is not one of ours.
func CoverExt(mime string) string {
	for _, c := range coverTypes {
		if c.mime == mime {
			return c.ext
		}
	}
	return ""
}

// Root is the folder that holds every community game.
func Root(dataDir string) string { return filepath.Join(dataDir, "community") }

// VersionDir is where one version's files live. The caller must have validated id and version.
func VersionDir(dataDir, id, version string) string { return filepath.Join(Root(dataDir), id, version) }

// ArchivePath is the version's game.tar.gz.
func ArchivePath(dataDir, id, version string) string {
	return filepath.Join(VersionDir(dataDir, id, version), "game.tar.gz")
}

// CoverPath is the version's cover for a stored content type, or "" when mime is not a known cover type.
func CoverPath(dataDir, id, version, mime string) string {
	ext := CoverExt(mime)
	if ext == "" {
		return ""
	}
	return filepath.Join(VersionDir(dataDir, id, version), "cover."+ext)
}

// Options says what to publish. Empty ID, Version, Title or Note are read from Dir/hull.json.
type Options struct {
	DataDir string
	Dir     string
	ID      string
	Version string
	Title   string
	Note    string
	Now     time.Time
}

// Result is what was stored.
type Result struct {
	ID, Version, Title, Note, SHA256, CoverMime string
	Size                                        int64
}

type manifest struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Note    string `json:"note"`
	Version string `json:"version"`
}

const (
	maxTitle = 80
	maxNote  = 1000
)

// Publish packs o.Dir and stores it as a new version. It refuses a version that exists or is not greater than
// the latest, so a version number always names one set of bytes.
func Publish(st *store.Store, o Options) (Result, error) {
	info, err := os.Stat(o.Dir)
	if err != nil || !info.IsDir() {
		return Result{}, fmt.Errorf("publish: --dir %s is not a folder", o.Dir)
	}
	mf, err := readManifest(o.Dir)
	if err != nil {
		return Result{}, err
	}
	pick := func(flag, fromFile string) string {
		if flag != "" {
			return flag
		}
		return fromFile
	}
	id := pick(o.ID, mf.ID)
	ver := pick(o.Version, mf.Version)
	title := pick(o.Title, mf.Title)
	note := pick(o.Note, mf.Note)
	if id == "" {
		return Result{}, errors.New("publish: no id: pass --id or put \"id\" in hull.json")
	}
	if !ValidID(id) {
		return Result{}, fmt.Errorf("publish: id %q: use 1 to 40 of a-z, 0-9 and -", id)
	}
	if ver == "" {
		return Result{}, errors.New("publish: no version: pass --version or put \"version\" in hull.json")
	}
	nv, err := ParseVersion(ver)
	if err != nil {
		return Result{}, fmt.Errorf("publish: %w", err)
	}
	if title == "" {
		title = id
	}
	if len([]rune(title)) > maxTitle {
		return Result{}, fmt.Errorf("publish: title is longer than %d characters", maxTitle)
	}
	if len([]rune(note)) > maxNote {
		return Result{}, fmt.Errorf("publish: note is longer than %d characters", maxNote)
	}

	existing, err := st.CommunityVersions(id)
	if err != nil {
		return Result{}, err
	}
	for _, e := range existing {
		ev, perr := ParseVersion(e.Version)
		if perr != nil {
			continue
		}
		if ev.Compare(nv) == 0 {
			return Result{}, fmt.Errorf("publish: %s %s already exists; bump the version (versions are never overwritten)", id, nv)
		}
	}
	SortNewestFirst(existing)
	if len(existing) > 0 {
		if lv, perr := ParseVersion(existing[0].Version); perr == nil && nv.Compare(lv) < 0 {
			return Result{}, fmt.Errorf("publish: %s %s is not greater than the latest, %s", id, nv, lv)
		}
	}

	gameDir := filepath.Join(Root(o.DataDir), id)
	if err := os.MkdirAll(gameDir, 0o700); err != nil {
		return Result{}, fmt.Errorf("publish: %w", err)
	}
	// Build in a hidden sibling and rename, so a crash leaves no half-written version folder behind.
	tmp, err := os.MkdirTemp(gameDir, ".tmp-")
	if err != nil {
		return Result{}, fmt.Errorf("publish: %w", err)
	}
	defer os.RemoveAll(tmp)

	skip, _ := filepath.Abs(Root(o.DataDir))
	size, sum, err := Pack(o.Dir, filepath.Join(tmp, "game.tar.gz"), skip)
	if err != nil {
		return Result{}, err
	}
	coverMime := ""
	if src, c := FindCover(o.Dir); src != "" {
		if err := copyFile(src, filepath.Join(tmp, "cover."+c.ext)); err != nil {
			return Result{}, fmt.Errorf("publish: copying cover %s: %w", src, err)
		}
		coverMime = c.mime
	}
	final := VersionDir(o.DataDir, id, nv.String())
	if _, err := os.Stat(final); err == nil {
		return Result{}, fmt.Errorf("publish: %s already holds files for %s %s but the catalog has no row; remove them first", final, id, nv)
	}
	if err := os.Rename(tmp, final); err != nil {
		return Result{}, fmt.Errorf("publish: %w", err)
	}
	now := o.Now
	if now.IsZero() {
		now = time.Now()
	}
	row := store.CommunityVersion{GameID: id, Version: nv.String(), Title: title, Note: note, Size: size,
		SHA256: sum, CoverMime: coverMime, PublishedAt: now}
	if err := st.AddCommunityVersion(row); err != nil {
		os.RemoveAll(final)
		return Result{}, fmt.Errorf("publish: %w", err)
	}
	return Result{ID: id, Version: nv.String(), Title: title, Note: note, SHA256: sum, CoverMime: coverMime, Size: size}, nil
}

// Remove deletes one version's row and files.
func Remove(st *store.Store, dataDir, id, version string) error {
	if !ValidID(id) {
		return fmt.Errorf("remove: id %q: use 1 to 40 of a-z, 0-9 and -", id)
	}
	v, err := ParseVersion(version)
	if err != nil {
		return fmt.Errorf("remove: %w", err)
	}
	if err := st.RemoveCommunityVersion(id, v.String()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("remove: %s %s is not in the catalog", id, v)
		}
		return fmt.Errorf("remove: %w", err)
	}
	if err := os.RemoveAll(VersionDir(dataDir, id, v.String())); err != nil {
		return fmt.Errorf("remove: row deleted but files not: %w", err)
	}
	os.Remove(filepath.Join(Root(dataDir), id)) // only succeeds when empty
	return nil
}

func readManifest(dir string) (manifest, error) {
	var m manifest
	p := filepath.Join(dir, "hull.json")
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, fmt.Errorf("publish: reading %s: %w", p, err)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("publish: %s: %w", p, err)
	}
	return m, nil
}

// FindCover returns the cover file at the top of dir, preferring webp, then jpg, then png.
func FindCover(dir string) (string, struct{ ext, mime string }) {
	for _, c := range coverTypes {
		p := filepath.Join(dir, "cover."+c.ext)
		if fi, err := os.Lstat(p); err == nil && fi.Mode().IsRegular() {
			return p, c
		}
	}
	return "", struct{ ext, mime string }{}
}

func isCoverName(name string) bool {
	for _, c := range coverTypes {
		if name == "cover."+c.ext {
			return true
		}
	}
	return false
}

// excluded says whether the entry at rel (slash separated, relative to the game folder) stays out of the archive.
// Build output and tooling folders are never part of a game's source; env files may hold secrets; covers are
// stored beside the archive.
func excluded(rel string, isDir bool) bool {
	parts := strings.Split(rel, "/")
	name := parts[len(parts)-1]
	if isDir {
		if name == "node_modules" || name == ".git" {
			return true
		}
		return len(parts) == 1 && (name == ".hull" || name == "dist")
	}
	if name == ".env" || strings.HasPrefix(name, ".env.") {
		return true
	}
	return len(parts) == 1 && isCoverName(name)
}

// Pack writes dir as a gzip-compressed tar at dest and returns its size and sha256. Paths in the archive are
// relative; file modes are kept; symlinks and other special files are skipped. skipAbs is an absolute folder to
// leave out (the catalog itself, when the data folder sits inside the game folder).
func Pack(dir, dest, skipAbs string) (int64, string, error) {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, "", fmt.Errorf("pack: %w", err)
	}
	defer out.Close()
	h := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(out, h))
	tw := tar.NewWriter(gz)

	walkErr := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return fmt.Errorf("pack: reading %s: %w", path, err)
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == "." {
			return err
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if abs, _ := filepath.Abs(path); skipAbs != "" && abs == skipAbs {
				return filepath.SkipDir
			}
			if excluded(rel, true) {
				return filepath.SkipDir
			}
		} else if excluded(rel, false) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return fmt.Errorf("pack: %s: %w", path, err)
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return nil // symlinks, sockets, devices
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return fmt.Errorf("pack: %s: %w", path, err)
		}
		hdr.Name = rel
		if info.IsDir() {
			hdr.Name += "/"
		}
		hdr.Mode = int64(info.Mode().Perm())
		hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname = 0, 0, "", "" // who owns files on the publisher's machine is not the player's business
		if err := tw.WriteHeader(hdr); err != nil {
			return fmt.Errorf("pack: %s: %w", path, err)
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return fmt.Errorf("pack: %w", err)
		}
		defer f.Close()
		if _, err := io.CopyN(tw, f, hdr.Size); err != nil {
			return fmt.Errorf("pack: %s: %w", path, err)
		}
		return nil
	})
	if walkErr != nil {
		return 0, "", walkErr
	}
	if err := tw.Close(); err != nil {
		return 0, "", fmt.Errorf("pack: %w", err)
	}
	if err := gz.Close(); err != nil {
		return 0, "", fmt.Errorf("pack: %w", err)
	}
	if err := out.Sync(); err != nil {
		return 0, "", fmt.Errorf("pack: %w", err)
	}
	fi, err := out.Stat()
	if err != nil {
		return 0, "", fmt.Errorf("pack: %w", err)
	}
	return fi.Size(), hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
