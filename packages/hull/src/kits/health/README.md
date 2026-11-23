# health kit

Hit points with hit zones, and a weapon that hurts them.

- **Behaviours**: `Health` (`damage(amount, zone, from)`, `heal`, `revive`; signals `damaged`, `healed`, `died`),
  `HealthHud` (bar), `Weapon` (a ray or a sweep from its node's forward; hurts the first thing with a `Health`).
- **Hit zones**: the `tag` of the collider that was hit ("head", "nape", "limb:left-arm") picks the multiplier.
  Override per entity with `health.zones = { nape: 5 }`. A collider on a child finds the `Health` above it.
- **Tunables** (`health` block): `playerMax`, `invulnSeconds`, `headMultiplier`, `napeMultiplier`, `limbMultiplier`.
  `Weapon` fields: `action`, `damage`, `range`, `rate`, `radius`, `height`, `sound`, `mask`; signals `hit`, `fired`.
- **Config**: `ui-theme/hud`, `sound/hit`.
- **Bench**: `bench.ts` (a gun and three enemies). **Test**: `health.test.ts`.
- **Zones as numbers** (`zones.ts`): `zoneEffect(damage, cutAt, shallowAt)` gives `ZONE_CUT`, `ZONE_SHALLOW` or `ZONE_NONE`;
  `coveredDamage`; `regenerate` (hit points as a fraction of full, after a quiet spell). AOTT's titan parts and soldier use them. Test: `zones.test.ts`.

## Use it

```ts
const me = w.spawn('player');
me.add(Health, { max: 100, hp: 100 });
me.add(HealthHud);                                  // a bar
me.add(Weapon, { action: 'fire', damage: 25, range: 40 });
```

## Wiring

- A thing that can be hurt has `Health` on it or on a parent of its collider; a `Weapon` hurts the first `Health` its ray or sweep reaches (mask picks layers).
- `HealthHud` needs `ui-theme/hud`; the weapon's sound needs `sound/hit`. Copy them from the kit's `config/`.
- Listen with `health.damaged.connect(...)`, `healed`, `died` (see the signals above).
