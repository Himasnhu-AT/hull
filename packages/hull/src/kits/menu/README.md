# menu kit

A title screen that holds the game until Start, and a result screen with a stats table and Play again.

- **Behaviours**: `TitleScreen` (`title`, `subtitle`, `start()`, signal `begun`), `ResultScreen` (`show(won, stats)`,
  `playAgain()`, signal `again`, texts `winText` / `loseText`; up to 8 stat rows).
- **Pause flag**: both use `flagsOf(world).paused`, the flag the pause kit uses, and hold it each step while they are up, so
  the `pause` action cannot dismiss them. Declared state (`started`, `shown`, `won`, `rows`) is in the checksum and saves.
- **Screens**: `config/ui-screen/title.json` (action `title.start`; values `title`, `subtitle`) and
  `config/ui-screen/result.json` (action `result.again`; values `heading`, `stat.N.label`, `stat.N.value`). The first
  button takes focus, so Enter, the arrow keys and a gamepad d-pad work. Colours and type come from the game's `ui-theme`.
- **Layer**: both are menus: while one shows, every HUD-layer `KitUi` (Hud, HealthHud, StockHud, ...) is hidden. The first button takes focus; Enter, Space and
  the gamepad's south button press the focused button (the first one if focus was lost to a click on the canvas).
- **Stat rows**: `show(won, stats)` lists every entry it is given, up to 8 (a value of 0 is a row). The panel is laid out at 1280x720 and scaled, so
  all rows fit a 640x360 window.
- **Tunables**: none.
- **Wiring**: spawn the TitleScreen first. Do not add a PauseMenu that should open over the title: the title wins.
  Connect `again` to the game's restart (`world.reset`-style code of your own).
- **Bench**: `bench.ts`. **Test**: `menu.test.ts`.

## Use it

```ts
const title = world.spawn('title').add(TitleScreen, { title: 'Ironleaf', subtitle: 'Find the gate' });
const results = world.spawn('results').add(ResultScreen);
title.begun.connect(() => hud.message('Go!', 2));
results.again.connect(() => restartLevel());
player.get(Health)!.died.connect(() => results.show(false, { Time: Math.round(world.time) }));
```
