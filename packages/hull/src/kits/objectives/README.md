# objectives kit

A list of goals with ids, optional counts and signals, saved with the save kit and shown by the Hud.

- **Behaviour**: `Objectives` on a node named `objectives` (the Hud finds it by that name).
- **Methods**: `add(id, text, {count})`, `progress(id, n = 1)`, `complete(id)`, `remove(id)`, `get(id)`, `isDone(id)`,
  `remaining`, `line(goal)`. `progress` finishes a goal at its count; a goal finishes once.
- **Signals**: `changed(id)` on any change, `completed(id)` when one goal finishes, `allDone()` once when the last one
  does (adding a goal afterwards opens the list again).
- **State**: `goals` and `finished` are declared state: part of the checksum, and saved when the node is in the `save`
  group (`node.addTo(GROUP.save)`).
- **Tunables**: none.
- **Config**: none. The look comes from the `ui-theme` of the game, through the Hud.
- **Wiring**: add a `Hud` node to show the list. Nothing else is needed.
- **Bench**: `bench.ts`. **Test**: `objectives.test.ts`.

## Use it

```ts
const goals = world.spawn('objectives').addTo(GROUP.save).add(Objectives);
goals.add('gems', 'Collect the gems', { count: 5 });
goals.add('exit', 'Reach the exit');
pickups.collected.connect(() => goals.progress('gems'));
goals.completed.connect((id) => { if (id === 'gems') world.find('hud')?.get(Hud)?.message('Gems done', 3); });
goals.allDone.connect(() => world.find('results')?.get(ResultScreen)?.show(true, { Time: 94 }));
```
