# pickups kit

Things to collect, and the counters they fill.

- **Behaviours**: `Pickup` (`kind`, `amount`, `respawn`; signal `collected`), `Stock` (named counters with caps:
  `add`, `take`, `drain`, `get`; signal `changed`), `StockHud`. `scatterPickups(world, level, kind, count, opts)` places them
  on free floor.
- **Kinds**: `health` heals the `Health` of a node in the `player` group; any other kind ("gas", "ammo", "blades") fills
  the `Stock` of that name. A pickup the taker has no room for is left alone.
- **Tunables** (`pickup` block): `spinSpeed`, `bobHeight`, `bobSpeed`, `collectRadius`, `height`.
- **Config**: `material/pickup-<kind>`, `sound/pickup`.
- **Bench**: `bench.ts`. **Test**: `pickups.test.ts`.
