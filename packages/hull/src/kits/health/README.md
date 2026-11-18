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
