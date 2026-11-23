# inventory kit

What a character carries: named items with counts, a number of slots and a stack limit, with signals and saving.

- **Behaviour**: `Inventory` (`capacity` kinds at once, `stack` per kind, `limits` per name; `add(name, n)` returns how many fitted,
  `remove`, `clear`, `count`, `has`, `room`, `names`, `slots`, `total`; signals `changed(name, count)` and `full(name, left)`). State `items` is saved.
- **Versus `Stock`** (pickups kit): Stock is resources with a cap each that drain and refill (gas, ammo) and are filled by `Pickup`.
  Inventory is things you keep, hand over and run out of room for. It sits beside Stock; it does not replace or copy it. Use both on one node.
- **Tunables**: none. **Config**: none.
- **Wiring**: nothing else required; the node joins the `save` group. Fill it from `Interactable.used` or `Pickup.collected`.
- **Bench**: `bench.ts`. **Test**: `inventory.test.ts`.

## Use it

```ts
const me = spawnFirstPerson(world);
const bag = me.add(Inventory, { capacity: 8, stack: 10 });
bag.changed.connect((name, n) => { if (name === 'key' && n > 0) openDoor(); });
bag.add('key', 1);
if (bag.remove('key', 1)) unlock();
```
