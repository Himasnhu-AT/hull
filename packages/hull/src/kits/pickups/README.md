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
- **Depot without a node** (`depot.ts`): `stepDepot(state, dt, inside, needs, {dwell, cooldown})` is true on the step a depot
  resupplies; `fillTo(current, max, fraction)`. For a player that is not a node with a `Stock`. Test: `depot.test.ts`.

## Use it

```ts
scatterPickups(w, level, 'health', 5, { amount: 30, respawn: 20 });
scatterPickups(w, level, 'gas', 4, { amount: 50 });   // needs a Stock with caps.gas on the player
```

## Wiring

- The taker is a node in the `player` group; `health` pickups need a `Health` on it, any other kind needs a `Stock` of that name (`player.add(Stock, { caps: { gas: 100 } })`).
- Add `material/pickup-<kind>` for each kind and `sound/pickup` with `kit.add {"kit":"pickups"}`. `StockHud` needs `ui-theme/hud`.
