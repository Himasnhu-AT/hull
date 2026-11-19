import Type, { type Static } from 'typebox';
import { vec3Schema } from './character.ts';
import { ref, ui } from './ui.ts';

// SCHEMAS.md section 6b. A move-set is what a fighter can do with its weapon: one entry per move, with its damage,
// its timing windows and what it can be cancelled into. The weapon is a line in a character socket's space; a
// trace sweeps that line between fixed steps, so a hit lands where the blade is drawn.
const vec3 = Type.Unsafe<[number, number, number]>({ ...vec3Schema, ...ui({ widget: 'vec3' }) });

const range = Type.Unsafe<[number, number]>({
  type: 'array', prefixItems: [{ type: 'number', minimum: 0 }, { type: 'number', minimum: 0 }], minItems: 2, maxItems: 2, items: false,
});

/** A window is a [from, to] range of seconds into the move, or a list of them (a move with two cuts). */
const windowSpec = Type.Union([range, Type.Array(range, { minItems: 1 })], ui({ widget: 'keys' }));

const move = Type.Object(
  {
    note: Type.Optional(Type.String()),
    clip: Type.Optional(Type.String({ ...ui({ help: 'The animation clip of this move, for people reading the file. Default: the move name.' }) })),
    trigger: Type.Optional(Type.String({ ...ui({ help: 'Animator trigger that starts the clip. Default: the clip name.' }) })),
    input: Type.Optional(Type.String({ ...ui({ help: 'The button this move answers: light, heavy, charged, finisher, or any word the game maps.' }) })),
    start: Type.Optional(Type.Boolean({ default: true, ...ui({ help: 'false: only reachable by cancelling out of another move (a string\'s second and third cut).' }) })),
    stance: Type.Optional(Type.String({ ...ui({ help: 'Only usable in this stance. Empty: any stance.' }) })),
    length: Type.Number({ exclusiveMinimum: 0, ...ui({ widget: 'dial', unit: 's', step: 0.01, help: 'How long the move lasts, start to ready again.' }) }),
    damage: Type.Number({ minimum: 0, default: 10, ...ui({ widget: 'dial', step: 1, help: 'Hit points taken by a clean hit.' }) }),
    posture: Type.Optional(Type.Number({ minimum: 0, default: 10, ...ui({ widget: 'dial', step: 1, help: 'Posture added to the one who blocks it or is hit by it.' }) })),
    reach: Type.Optional(Type.Number({ exclusiveMinimum: 0, ...ui({ unit: 'm', step: 0.05, help: 'How far from the fighter the blade can land, for the enemy brain and the range check of a finisher.' }) })),
    windows: Type.Optional(
      Type.Record(Type.String(), windowSpec, {
        ...ui({ help: 'Named ranges of the move, in seconds. trace: the blade is live. telegraph: the tell (glint or red flash). cancel: the move may be cut short. iframe: nothing can hurt. parry: reserved for a counter.' }),
      }),
    ),
    windowsFrom: Type.Optional(Type.Union([Type.Literal('move-set'), Type.Literal('clip'), Type.Literal('auto')], { default: 'move-set', ...ui({ widget: 'segments', help: 'move-set: the windows above. clip: the windows named inside the animation clip (animator.inWindow). auto: the move-set\'s, and the clip\'s for names the move-set does not list.' }) })),
    cancelsInto: Type.Optional(Type.Array(Type.String(), ui({ help: 'Moves reachable in this move\'s cancel window.' }))),
    unblockable: Type.Optional(Type.Boolean({ default: false, ...ui({ help: 'A red-flash attack: guard and deflect do nothing, only a dodge avoids it.' }) })),
    guardBreak: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 1, ...ui({ help: 'Posture multiplier against a guard (a charged heavy that breaks it).' }) })),
    finisher: Type.Optional(Type.Boolean({ default: false, ...ui({ help: 'Only starts, and only hurts, a fighter whose posture is broken; deals a fraction of its hit points.' }) })),
    stagger: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 's', help: 'How long a clean hit staggers. Default: the combat tuning.' }) })),
    knockback: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 'm', step: 0.05, help: 'How far a clean hit pushes the target.' }) })),
    hitStop: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, ...ui({ unit: 's', step: 0.005, help: 'Both fighters freeze this long on a clean hit. Default: the combat tuning (light or heavy).' }) })),
    lunge: Type.Optional(
      Type.Object(
        {
          distance: Type.Number({ ...ui({ unit: 'm', step: 0.05 }) }),
          from: Type.Number({ minimum: 0, ...ui({ unit: 's' }) }),
          to: Type.Number({ minimum: 0, ...ui({ unit: 's' }) }),
        },
        { additionalProperties: false, ...ui({ help: 'Steps forward (or back, negative) over this part of the move. Until the animation carries root motion.' }) },
      ),
    ),
    sound: Type.Optional(Type.String({ ...ref('sound', { help: 'Played when the move starts.' }) })),
  },
  { additionalProperties: false },
);

export const moveSetSchema = Type.Object(
  {
    kind: Type.Literal('move-set'),
    note: Type.Optional(Type.String()),
    weapon: Type.Object(
      {
        socket: Type.String({ minLength: 1, ...ui({ help: 'A socket of the fighter\'s character the blade hangs from.' }) }),
        base: vec3,
        tip: vec3,
        radius: Type.Optional(Type.Number({ minimum: 0, default: 0.04, ...ui({ unit: 'm', step: 0.005, help: 'Thickness of the blade for the trace.' }) })),
      },
      { additionalProperties: false },
    ),
    stances: Type.Optional(Type.Array(Type.String(), ui({ help: 'The stances this fighter knows; the first is the starting one.' }))),
    moves: Type.Record(Type.String({ minLength: 1 }), move),
  },
  { additionalProperties: false, title: 'Hull move-set' },
);

export type MoveSet = Static<typeof moveSetSchema>;
export type Move = Static<typeof move>;
