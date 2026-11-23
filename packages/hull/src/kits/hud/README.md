# hud kit

One HUD behaviour with named slots a game fills: score, timer, objective, messages, a prompt and bars.

- **Behaviour**: `Hud` (a `KitUi`) on a node named "hud". Slots (each returns the Hud, and an empty slot is not drawn):
  `score(read, label?)`, `timer(read, { countDown })`, `objective(text | () => string)`, `message(text, seconds?)`,
  `prompt(text | null)`, `bar(name, read, max)`.
- **Messages**: a toast at the top. One shows at a time for its seconds of game time, the rest wait in order (up to
  `maxQueued`). The clock does not run while the game is paused. Message, prompt and objective text are declared state.
- **Prompt**: bottom centre, for "E to open". The interact kit uses it when a Hud exists.
- **Objectives**: when a node named "objectives" has an `Objectives` (objectives kit), its goals are listed on the left.
- **Look**: every widget takes its colours, type and spacing from the game's `ui-theme`; restyle the whole HUD by editing
  that file. Corners: bars top left, score and time top right, goals left, toast top, prompt bottom.
- **Layer and visibility**: the HUD is on layer `hud`: it is hidden while a menu (title, result, pause, game over) shows. `hud.get(Hud)!.show(false)` hides it
  yourself, and `show(true)` brings it back. The same goes for `HealthHud`, `StockHud`, `WaveHud`, `Crosshair` and `InteractPrompt`.
- **Scale**: it follows the window (1280x720 is full size, 640x360 half), so the middle of the picture stays clear.
- **Tunables** (`hud` block): `messageSeconds`, `maxQueued`.
- **Config**: none of its own.
- **Wiring**: nothing required. It runs headless in Node (messages still time out).
- **Bench**: `bench.ts`. **Test**: `hud.test.ts`.

## Use it

```ts
const hud = world.spawn('hud').add(Hud);
hud.score(() => game.score);
hud.timer(() => game.timeLeft, { countDown: true });
hud.objective('Reach the tower');
hud.bar('Stamina', () => stamina.value, 100);
hud.message('Wave 2', 3);
interactable.focused.connect((on) => hud.prompt(on ? 'E to open' : null));
```
