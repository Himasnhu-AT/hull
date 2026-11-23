# saves kit

Save slots for a game made of kits.

- **Behaviour**: `SaveSlots` (`save(n)`, `load(n)`, `savedAt(n)`, `slots`, signals `saved`, `loaded`). It saves every node
  in the `save` group: its position and rotation, and the declared `static state` fields of every behaviour on it (the
  same fields the checksum covers). Nodes are matched by name on load.
- **What is not saved**: random streams, the clock, and nodes not in the `save` group (enemies; the Spawner restarts its
  current wave after a load through its `afterLoad`). A behaviour may define `afterLoad()`.
- **Storage**: the platform's saves (files in the desktop shell, IndexedDB or localStorage in a browser), versioned.
- **Bench**: `bench.ts`. **Test**: `saves.test.ts`.
- To make your own thing saveable: `node.addTo('save')`, a unique node name, and `static state = [...]` on the behaviour.

## Use it

```ts
w.spawn('saves').add(SaveSlots);
node.addTo('save');   // every node you want kept: unique name, and `static state = [...]` on its behaviours
saves.save(1); saves.load(1);
```

## Wiring

- The pause menu's Save/Load buttons find the node named `saves`; spawn it early.
- Only nodes in the `save` group are kept, matched by name on load; spawn them in ready, not later.
