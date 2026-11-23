# pause kit

A pause menu.

- **Behaviour**: `PauseMenu` on a node spawned before the world (after the `TitleScreen`, when the game has one). The `pause` action (Esc, P, the start button) toggles it. While
  paused every kit behaviour skips its step (they read `flagsOf(world).paused`); the clock keeps running so the menu still
  reads input. The flag is part of the checksum.
- **Menu**: `config/ui-screen/pause.json` with the actions `pause.resume`, `pause.save.N`, `pause.load.N` and the values
  `slot.N` and `message`. Edit the layout freely.
- **Saves**: Save and Load buttons use the `SaveSlots` on the node named `saves`, if there is one.
- **Bench**: `bench.ts`. **Test**: `pause.test.ts`.
- For a game of your own: check `flagsOf(world).paused` at the top of your `fixedUpdate`.

## Use it

```ts
w.spawn('pause').add(PauseMenu);   // before the world (after a TitleScreen), so a step sees the pause flag before anything acts
```

## Wiring

- Needs the action `pause` in the input map and `config/ui-screen/pause.json` (add it with `kit.add {"kit":"pause"}`).
- Save and Load buttons need a node named `saves` with `SaveSlots`.
- Your own behaviours check `flagsOf(world).paused` at the top of `fixedUpdate`.
