import Type, { type Static } from 'typebox';
import { ref, ui } from './ui.ts';

// SCHEMAS.md section 6b. An enemy is stats plus a pattern list: weighted sequences of moves, each with a tell
// before it, and conditions on distance, health and phase that say when a pattern may be picked.
const range = Type.Unsafe<[number, number]>({
  type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], minItems: 2, maxItems: 2, items: false,
});

const step = Type.Object(
  {
    move: Type.Optional(Type.String({ minLength: 1, ...ui({ help: 'A move of the enemy\'s move-set. Leave it out for a step that only travels (a retreat).' }) })),
    telegraph: Type.Number({ minimum: 0, default: 0.5, ...ui({ widget: 'dial', unit: 's', step: 0.05, help: 'Seconds the enemy shows the tell before the move starts: the time you get to read it.' }) }),
    gap: Type.Optional(Type.Number({ minimum: 0, default: 0, ...ui({ unit: 's', step: 0.05, help: 'Pause after the move, before the next step.' }) })),
    feint: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 's', step: 0.05, help: 'Cut the move short this many seconds in: a feint that baits a block or a dodge.' }) })),
    unblockable: Type.Optional(Type.Boolean({ ...ui({ help: 'Overrides the move: a red-flash attack.' }) })),
    travel: Type.Optional(
      Type.Object(
        {
          by: Type.Optional(Type.Number({ ...ui({ unit: 'm', step: 0.1, help: 'Metres to close (positive) or open (negative) on the target, after the tell and before the move.' }) })),
          to: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm', step: 0.1, help: 'Distance to the target to stop at. Wins over "by".' }) })),
          speed: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 5, ...ui({ unit: 'm/s', step: 0.1 }) })),
        },
        { additionalProperties: false, ...ui({ help: 'A dash in, a back-step or a retreat: the enemy runs (the animator\'s speed parameter is set) before the move starts.' }) },
      ),
    ),
  },
  { additionalProperties: false },
);

const when = Type.Object(
  {
    distance: Type.Optional(range),
    health: Type.Optional(Type.Unsafe<[number, number]>({ ...range, ...ui({ help: 'Fraction of full health, 0 to 1.' }) })),
    phase: Type.Optional(Type.Unsafe<[number, number]>({ ...range, ...ui({ help: 'Phases are counted by \'phases\' below, from 0.' }) })),
    stance: Type.Optional(Type.Array(Type.String(), ui({ help: 'Only while the target fights in one of these stances.' }))),
    clear: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm', help: 'Only while no friend of this enemy is within this many metres of the target (an archer waits for a clear line).' }) })),
  },
  { additionalProperties: false },
);

const pattern = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    weight: Type.Number({ minimum: 0, default: 1, ...ui({ widget: 'dial', step: 0.1, help: 'Chance of being picked among the patterns that fit.' }) }),
    steps: Type.Array(step, { minItems: 1 }),
    recover: Type.Optional(Type.Number({ minimum: 0, default: 0.8, ...ui({ unit: 's', step: 0.05, help: 'Time before the enemy thinks again.' }) })),
    token: Type.Optional(Type.Boolean({ default: true, ...ui({ help: 'false: may start without a place in the attack queue (a ranged shot).' }) })),
    when: Type.Optional(when),
    answers: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }), ui({ help: 'Weight multiplier by the target\'s stance: { "stone": 3 } makes this pattern three times likelier against a target in Stone.' }))),
  },
  { additionalProperties: false },
);

export const enemySchema = Type.Object(
  {
    kind: Type.Literal('enemy'),
    note: Type.Optional(Type.String()),
    moveSet: Type.String({ ...ref('move-set') }),
    character: Type.Optional(Type.String({ ...ref('character') })),
    health: Type.Number({ exclusiveMinimum: 0, default: 100, ...ui({ widget: 'dial', step: 5 }) }),
    posture: Type.Optional(
      Type.Object(
        {
          max: Type.Number({ exclusiveMinimum: 0, default: 80, ...ui({ widget: 'dial', step: 5, help: 'Posture that breaks the guard and opens a finisher.' }) }),
          recover: Type.Number({ minimum: 0, default: 10, ...ui({ unit: '/s', help: 'Posture regained each second, once the delay has passed.' }) }),
          delay: Type.Number({ minimum: 0, default: 1.5, ...ui({ unit: 's' }) }),
          broken: Type.Number({ minimum: 0, default: 2.4, ...ui({ unit: 's', help: 'How long a broken enemy stays open.' }) }),
        },
        { additionalProperties: false },
      ),
    ),
    weakTo: Type.Optional(Type.String({ ...ui({ help: 'The stance that deals extra posture damage to this enemy.' }) })),
    finisherDamage: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 1, ...ui({ widget: 'slider', step: 0.05, help: 'Fraction of full health a finisher takes. 1 kills; a boss takes less per finisher.' }) })),
    speed: Type.Optional(
      Type.Object(
        {
          walk: Type.Number({ minimum: 0, default: 2.4, ...ui({ unit: 'm/s', step: 0.1 }) }),
          circle: Type.Optional(Type.Number({ minimum: 0, default: 1.4, ...ui({ unit: 'm/s', step: 0.1 }) })),
          run: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm/s', step: 0.1, help: 'Speed when the target is far (more than 1.5 m outside the band).' }) })),
          turn: Type.Optional(Type.Number({ minimum: 0, default: 6, ...ui({ unit: 'rad/s', step: 0.5 }) })),
        },
        { additionalProperties: false },
      ),
    ),
    spacing: Type.Optional(
      Type.Object(
        {
          min: Type.Number({ minimum: 0, ...ui({ unit: 'm' }) }),
          max: Type.Number({ minimum: 0, ...ui({ unit: 'm' }) }),
          wait: Type.Optional(Type.Unsafe<[number, number]>({ ...range, ...ui({ help: 'The band to keep while another enemy holds the attack places: circling at a distance instead of crowding in.' }) })),
        },
        { additionalProperties: false, ...ui({ help: 'The band of distance the enemy likes to keep from its target: closer and it backs off, farther and it approaches, inside it circles.' }) },
      ),
    ),
    think: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 0.3, ...ui({ unit: 's', step: 0.05, help: 'How often an idle enemy considers attacking.' }) })),
    phases: Type.Optional(Type.Array(Type.Number({ minimum: 0, maximum: 1 }), ui({ help: 'Health fractions where a new phase starts, highest first: [0.66, 0.33] gives phases 0, 1 and 2.' }))),
    patterns: Type.Array(pattern, { minItems: 1 }),
  },
  { additionalProperties: false, title: 'Hull enemy' },
);

export type Enemy = Static<typeof enemySchema>;
export type EnemyPattern = Static<typeof pattern>;
