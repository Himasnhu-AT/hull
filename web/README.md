# Engine website

Static Astro site for the engine (working name **Hull**). Concept, art direction and QA notes
are in `DESIGN.md`. All copy and facts live in `src/data/site.ts`.

```sh
pnpm install
pnpm build            # → dist/  (run through memgate on this machine: memgate -- pnpm build)
pnpm preview          # or: node ~/.claude/skills/awwwards/scripts/serve.mjs dist --port 4401
```

## Before publishing, replace the placeholders

| What | Where | Now |
|---|---|---|
| Public name | `src/data/site.ts` `site.name` | "Hull" (working name; the crate is `engine`) |
| Production URL | `src/data/site.ts` `site.url`, `astro.config.mjs` `site`, `public/robots.txt` | `https://hull.marl.studio` (placeholder) |
| Repo, docs, crates.io | `src/data/site.ts` `site.repo` / `site.docs` | `null`: the site says "not public yet" |
| Studio | `src/data/site.ts` `site.studio` | `null`: not shown anywhere |
| Cargo.toml snippet | `src/data/site.ts` `code.cargo`, `src/pages/start.astro` | path dependency `../engine` |

The license (`MIT OR Apache-2.0`) and every number come from the engine repo.

## Images

`src/assets/shots/*.webp` are converted from real captures: Shroud and Courier screenshots
(`_source-shots/`, gitignored) plus fresh captures of the engine examples, taken offscreen and
muted through `scripts/play.py`:

- `ui_gallery --menu -- --accent r,g,b` for the five hero accents, settings, setup and pause
- `render_budget -- --props 40000 --pose overview --uncapped` with `render.budget` toggled for on/off
- `metrics_demo -- --metrics-window`, four runs, for the metrics window and runs table

`public/og.png` is composed from the five accent captures with the engine's own Barlow fonts.

## Figure

`src/components/BudgetFigure.astro` (Fig 1 on `/render-budget/`) was built with the anatomy skill.
Regenerate its static SVG with `node src/figures/budget/build.mjs`.
