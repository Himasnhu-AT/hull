# combat kit

Sword fights: fighters with posture and timed guards, blades traced against hurt shapes, enemies that run patterns from
config, lock-on and standoffs. Built on the animator (sockets, hurt shapes in `character.hits`), the health kit and the
follow camera. Its default config uses the materials and sounds of the third-person and health kits.

- **Config kinds**: `move-set` (the weapon line in a socket, and per move: input, stance, damage, posture damage, reach,
  windows, cancels, lunge) and `enemy` (stats, posture, weakness, spacing, phases, weighted patterns with tells, feints,
  red-flash steps and conditions). Schemas: `schemas/move-set.schema.json`, `schemas/enemy.schema.json`; format in
  docs/SCHEMAS.md 6b. Examples: `config/move-set/duelist.json`, `config/enemy/duelist.json`.
  `checkMoveSet` and `checkEnemy` check what a schema cannot (cancel names, windows inside the move).
- **`Combatant`**: health (the node's `Health`) and posture; `press(input)` (buffered, chains through cancel windows),
  `attack(move)`, `guard(on)`, `dodge(dx, dz)`, `receive(attack)`, `stagger`, `freeze`, `finish`-through-a-move.
  Signals (the one that was hit or did the deflecting): `hit`, `blocked`, `deflected`, `perfectDeflect`,
  `postureBroken`, `killed`, `dodged`, `moveEnded`. The same signals, for every fighter, are on `combatHub(world)`
  with `hitStop`, `shake`, `tell` and `moveStarted`.
- **Outcomes of a blow**, in order: an i-frame (dodge, or a move's `iframe` window) avoids it; a guard held in front stops
  a blockable one: raised within `perfectWindow` of the blow is a *perfect deflect* (attacker staggers and loses
  posture, you lose none), within `deflectWindow` a *deflect* (35% of the posture), otherwise a *block* (all of it, times
  the move's `guardBreak`); anything else is a clean hit (damage by hit zone, a stagger, hit-stop; `zoneDamage` 0 turns the zone multipliers off so a move does the damage it lists). Unblockable moves
  skip the guard and can only be dodged. Posture that fills breaks: the fighter is open for `brokenSeconds` and a move with
  `finisher: true` (it only starts when someone is broken in reach) takes `finisherDamage` of full health.
  A stance the target is `weakTo` multiplies posture damage by `weakBonus`; one it `resists` (the wrong stance) by `resistMult` (0.7).
  A plain block lets `blockChip` (15%) of the damage through (never a stagger); a deflect lets none. A fighter with
  `postureRecoverFight` set regains posture at that rate while a living enemy is within `fightRange`, else at `postureRecover`.
  The attack queue (`enemyBrain` tunables) holds `maxAttackers`; `breather` is the quiet time after an attacker finishes before another may start, `attackGap` the least time between two starts (both 0 by default).
  An enemy pattern with `rest: true` sets the brain's `streak` back to 0; `when.streak: [min, max]` limits a pattern to a
  streak of patterns in a row (a boss that resets after three); an interruption clears the streak too.
- **Traces** (`trace.ts`): in a move's `trace` window the blade (two points in a socket's space) is sampled every fixed
  step and swept from where it was to where it is, in enough sub-steps that nothing is skipped, against every other-team
  fighter's hurt shapes (capsule, sphere, box on bones). A fighter whose character has no `hits` is a 1.7 m capsule.
  One hit per fighter per window. The pose is built for the step with `animator.render(1, 0)`, so a trace works in a
  headless test and the hit is where the drawn blade is.
- **Windows**: `trace`, `telegraph` (the tell), `cancel`, `iframe`. Read from the move-set's seconds by default;
  `windowsFrom: "clip"` reads `animator.inWindow(name)` once the animation has windows. Both paths are live.
- **`EnemyBrain`**: keeps a distance band, circles, thinks every `think` seconds, picks a pattern whose conditions fit
  (weight, from the 'brain' random stream), takes a place in `attackTokens(world)` (`brainTuning.maxAttackers`, default 2),
  shows the tell for the step's `telegraph`, then plays the move; steps may feint or be unblockable. Phases come from
  the enemy's `phases` health fractions.
- **Ranged and movement (M10)**: a move's `shoot` releases a `Projectile` (`projectile.ts`) that flies straight and lands through the
  target's `receive`; a deflect turns it back at the shooter, a dodge lets it fly on; `hub.shot` lets the game hang a mesh on it. A pattern
  step may be a pure `travel` (dash in, back-step, retreat), patterns read the target's stance (`when.stance`, `answers`), wait their turn at
  `spacing.wait`, and an `EnemyBrain` can be `dormant` until `wake()`. The brain also drives the animator's `speed`.
- **Player**: `FighterInput` (actions `move`, `attack`, `heavy` (hold for charged), `guard`, `dodge`, `stance1-3`,
  `stanceNext`, `lock`, `lockNext`), `LockOn` (`pickLockTarget`, camera lock and the shake wiring), `FollowCamera`
  gained `lockTarget` and `shake(amount, seconds)`. `Standoff`: hidden wait, a twitch, a window to release.
- **Animator contract**: a move fires the trigger named by its `trigger` (default the clip, default the move name); the
  Combatant also sets `guarding`, `broken`, `dead` and fires `dodge`, `stagger`, `cancel`. See `config/anim-graph/combat`.
  Hit-stop sets `animator.timeScale` when the animator has one.
- **Tunables** (`combat`, `enemyBrain`, `fighter`, `lockOn` blocks): every window and multiplier above.
- **Bench**: `bench.ts` (a duel with `CombatDebug`: hurt shapes, blade, sweep, a window timeline over each head).
  **Tests**: `combat.test.ts`.
