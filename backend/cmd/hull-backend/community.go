package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/marlstudio/hull/backend/internal/community"
	"github.com/marlstudio/hull/backend/internal/config"
	"github.com/marlstudio/hull/backend/internal/store"
)

const communityUsage = `usage:
  hull-backend community publish --dir <game folder> [--id <id>] [--version <x.y.z>] [--note <text>]
  hull-backend community list
  hull-backend community remove --id <id> --version <x.y.z>`

// runCommunity runs the publishing commands against the same DATA_DIR the server uses, so it must run on the
// server's machine. It prints results to out and returns an error for anything that went wrong.
func runCommunity(args []string, getenv func(string) string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(communityUsage)
	}
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(cfg.DataDir, "hull.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	cmd, rest := args[0], args[1:]
	fs := flag.NewFlagSet("community "+cmd, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	switch cmd {
	case "publish":
		dir := fs.String("dir", "", "game folder")
		id := fs.String("id", "", "game id")
		version := fs.String("version", "", "version x.y.z")
		note := fs.String("note", "", "note")
		if err := fs.Parse(rest); err != nil {
			return fmt.Errorf("community publish: %w\n%s", err, communityUsage)
		}
		if fs.NArg() > 0 {
			return fmt.Errorf("community publish: unexpected argument %q\n%s", fs.Arg(0), communityUsage)
		}
		if *dir == "" {
			return fmt.Errorf("community publish: --dir is required\n%s", communityUsage)
		}
		res, err := community.Publish(st, community.Options{DataDir: cfg.DataDir, Dir: *dir, ID: *id, Version: *version, Note: *note})
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "id: %s\nversion: %s\nsize: %d\nsha256: %s\n", res.ID, res.Version, res.Size, res.SHA256)
		return nil
	case "list":
		if err := fs.Parse(rest); err != nil || fs.NArg() > 0 {
			return fmt.Errorf("community list takes no arguments\n%s", communityUsage)
		}
		rows, err := st.AllCommunityVersions()
		if err != nil {
			return err
		}
		byGame := map[string][]store.CommunityVersion{}
		for _, v := range rows {
			byGame[v.GameID] = append(byGame[v.GameID], v)
		}
		ids := make([]string, 0, len(byGame))
		for id := range byGame {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		if len(ids) == 0 {
			fmt.Fprintln(out, "no community games")
		}
		for _, id := range ids {
			vs := byGame[id]
			community.SortNewestFirst(vs)
			fmt.Fprintf(out, "%s  %s\n", id, vs[0].Title)
			for _, v := range vs {
				cover := "no cover"
				if v.CoverMime != "" {
					cover = "cover"
				}
				fmt.Fprintf(out, "  %s  %s  %d bytes  %s  %s\n", v.Version, v.PublishedAt.Format("2006-01-02"), v.Size, cover, v.SHA256)
			}
		}
		return nil
	case "remove":
		id := fs.String("id", "", "game id")
		version := fs.String("version", "", "version x.y.z")
		if err := fs.Parse(rest); err != nil || fs.NArg() > 0 {
			return fmt.Errorf("community remove: bad arguments\n%s", communityUsage)
		}
		if *id == "" || *version == "" {
			return fmt.Errorf("community remove: --id and --version are required\n%s", communityUsage)
		}
		if err := community.Remove(st, cfg.DataDir, *id, *version); err != nil {
			return err
		}
		fmt.Fprintf(out, "removed %s %s\n", *id, *version)
		return nil
	}
	return fmt.Errorf("community: unknown command %q\n%s", strings.TrimSpace(cmd), communityUsage)
}
