# interact kit

Things the player can use, and the prompt that says so: an Interactable, and an Interactor that finds the nearest one in front and fires it on the "interact" action.

- **Behaviours**: `Interactable` (`radius`, `prompt`, `enabled`, `once`, `height`, `sound`; `use(by)`; signal `used(by)`), `Interactor`
  (`action`, `key`, `height`, `mask`; `target`, `promptText`; signal `targetChanged`), `InteractPrompt` (its own bottom-centre prompt,
  added by the Interactor and hidden when a Hud shows the prompt).
- **Choice**: among enabled interactables within their `reach`, inside `halfAngle` of the node's forward (-Z), the nearest
  wins, unless a ray on `mask` (default the `world` layer) from the Interactor to it hits something first. A solid door should not
  put its collider on a child node, because only the interactable's own node is ignored by that ray.
- **Prompt**: pushed to the Hud (a node named `hud` with a behaviour that has `prompt(text | null)`) when the world has one.
- **Tunables** (`interact` block): `halfAngle`, `defaultRadius`, `closeEnough`.
- **Config**: `sound/interact`; the `interact` action (E, gamepad west) is in the `fps` and `third-person` input maps.
- **Wiring**: physics in the world (the Interactor installs nothing); put the Interactor on the node that looks
  (`FirstPerson.eye`) or on the player with `height` set. Interactables join the `save` group (`enabled`, `uses` are saved).
- **Bench**: `bench.ts`. **Test**: `interact.test.ts`.

## Use it

```ts
const me = spawnFirstPerson(world);
me.get(FirstPerson)!.eye.add(Interactor);
const door = world.spawn('door');
door.position.set(0, 1.5, -3);
const it = door.add(Interactable, { prompt: 'Open door', once: true });
it.used.connect((by) => { door.position.y += 3; });
```
