# Engine website

Static Astro site for the engine (working name **Hull**). Concept, art direction and QA notes
are in `DESIGN.md`. All copy and facts live in `src/data/site.ts`.

```sh
pnpm install
pnpm build            # → dist/  (a few seconds; no memgate needed)
pnpm preview          # or: node ~/.claude/skills/awwwards/scripts/serve.mjs dist --port 4401
```

## Before publishing, replace the placeholders

| What | Where | Now |
|---|---|---|
| Public name | `src/data/site.ts` `site.name` | "Hull" (working name; the crate is `engine`) |
| Production URL | `src/data/site.ts` `site.url`, `astro.config.mjs` `site`, `public/robots.txt` | `https://hull.marl.studio` (placeholder) |
| Studio | `src/data/site.ts` `site.studio` | `null`: not shown anywhere |
| crates.io | `src/data/site.ts` `code.cargo`, `src/pages/start.astro` (step 1 note) | not published: the snippet is a git dependency |

Real, not placeholders: `site.repo` (https://github.com/Himasnhu-AT/hull) and `site.docs` (its
`docs/` folder); each tab and the Performance page link to the matching `docs/*.md` on GitHub.

The license (`MIT OR Apache-2.0`) and every number come from the engine repo: the shell rows
from `docs/PORTING.md`, the Systems tabs from `docs/{LOOK,ANIM,VFX,AI,SOUND,WORLD,ACTIONS,L10N,NET,DEVKIT}.md`,
and the Performance page from `docs/PERF.md` (after-fix run, commit c8532d9; baseline 2327039).

## Pages

| Page | What |
|---|---|
| `/` | hero menu, Inside (shell tabs), Systems (subsystem tabs), code, two games, performance and render-budget teasers, devtools |
| `/performance/` | the 12 scene benchmarks after the fixes, what the first run caught, headless CPU benches, known limits |
| `/render-budget/` | the render budget write-up with its figure |
| `/games/shroud/`, `/games/courier/` | the two games built on the engine |
| `/start/` | Cargo.toml (git dependency and features) to ship build in seven steps |

## Benchmarks

Every number on `/performance/` and in the home teaser comes from `bench` in `src/data/site.ts`
(from `docs/PERF.md`). After a new `scripts/perf_suite.py run`, update `bench.commit` and each
scene's `after` values (and `bench.benches` after `bench.py run`); the headline, the
"vs baseline" column, the before → after figures in the fixes list, captions and scene counts
are computed. Prose in the block (`fixed`, `limits`, `sceneNote`) holds no memory figures: memory
is only shown in the table's Mem MB column.

## Images

`src/assets/shots/*.webp` are converted from real captures: Shroud and Courier screenshots
(`_source-shots/`, gitignored) plus fresh captures of the engine examples, taken offscreen and
muted through `scripts/play.py`:

- `ui_gallery --menu -- --accent r,g,b` for the five hero accents, settings, setup and pause
- `render_budget -- --props 40000 --pose overview --uncapped` with `render.budget` toggled for on/off
- `metrics_demo -- --metrics-window`, four runs, for the metrics window and runs table

Systems captures (2026-10-27, commit 0a08ebf, offscreen, 1920×1080, `cwebp -q 80`):

| File | Capture | Used on |
|---|---|---|
| `look-high.webp` (14 KB) | `look_showcase -- --quality high`, outdoor pose | home, Systems pair |
| `look-dusk.webp` (14 KB) | `look_showcase -- --quality high --look dusk`, outdoor pose | home, Systems pair |
| `look-metals.webp` (21 KB) | same run, `showcase.pose metals` | home, Look tab |
| `anim-crowd.webp` (33 KB) | `anim_demo -- --crowd 40`, `demo.cam lineup` | home, Anim tab |
| `vfx-explosion.webp` (14 KB) | `vfx_gallery`, `gallery.focus explosion` after 0.4 s | home, VFX tab |
| `ai-navmesh.webp` (78 KB) | `ai_crowd` (200 agents), `ai.nav.debug on` | home, AI tab |
| `ai-crowd.webp` (23 KB) | `ai_crowd`, debug off | Performance |
| `world-forest.webp` (114 KB) | `open_world -- --pose fly`, `cam.pose forest` | home, World tab |
| `world-fly.webp` (58 KB) | `open_world -- --pose fly` | Performance hero |

These flat-shaded captures come out smaller as WebP than as AVIF (ai-navmesh at 1920: 56 KB WebP,
88 KB AVIF), so they pass `formats={['webp']}` to `Shot`. Side-panel shots use widths up to 1280
at quality 60. Sound, Net, Input and Devkit have no capture: their panels show a measured number
from the docs instead.

`public/og.png` is composed from the five accent captures with the engine's own Barlow fonts.

## Figure

`src/components/BudgetFigure.astro` (Fig 1 on `/render-budget/`) was built with the anatomy skill.
Regenerate its static SVG with `node src/figures/budget/build.mjs`.
