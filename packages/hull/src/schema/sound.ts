import Type, { type Static, type TSchema } from 'typebox';
import { ref, ui, type UiHints } from './ui.ts';

// SCHEMAS.md section 4. A sound is one thing you can hear: a recipe of layers (synth), a sample, a pick among other
// sounds, or a generator registered in code. Every number in a recipe may be a [min, max] range, drawn from a
// seeded stream each time the sound plays, so a hit never sounds exactly the same twice but a bench render with
// the same seed is always the same.

/** x-ui for a number-or-range field. The Inspector needs min and max for the range widget because the schema's own
 *  bounds sit inside a union, where a form builder cannot read them. */
function rangeUi(min: number, max: number, hints: UiHints = {}): { 'x-ui': UiHints & { min: number; max: number } } {
  return { 'x-ui': { widget: 'range', ...hints, min, max } };
}

interface RangeOpts { default?: number; unit?: string; step?: number; help?: string; group?: string }

/** A fixed number or a [min, max] range. */
const numOrRange = (min: number, max: number, opts: RangeOpts = {}): TSchema => {
  const { default: d, ...hints } = opts;
  return Type.Union(
    [Type.Number({ minimum: min, maximum: max }), Type.Array(Type.Number({ minimum: min, maximum: max }), { minItems: 2, maxItems: 2 })],
    { ...(d === undefined ? {} : { default: d }), ...rangeUi(min, max, hints) },
  );
};

const noiseKinds = Type.Union([Type.Literal('white'), Type.Literal('pink'), Type.Literal('brown')], { default: 'white', ...ui({ widget: 'segments' }) });

const oscSource = Type.Object(
  {
    osc: Type.Union([Type.Literal('sine'), Type.Literal('triangle'), Type.Literal('square'), Type.Literal('sawtooth')], { ...ui({ widget: 'segments', group: 'Source' }) }),
    freq: numOrRange(10, 20000, { unit: 'Hz', group: 'Source' }),
    glideTo: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 16, ...ui({ widget: 'dial', step: 0.01, group: 'Source', help: 'Pitch at the end of the glide, as a multiple of freq (0.5 is an octave down).' }) })),
    glideTime: Type.Optional(Type.Number({ minimum: 0, maximum: 10, ...ui({ widget: 'dial', unit: 's', step: 0.005, group: 'Source', help: 'How long the glide takes. Default: the whole layer.' }) })),
    detune: Type.Optional(numOrRange(-1200, 1200, { unit: 'cents', group: 'Source' })),
  },
  { additionalProperties: false },
);

const noiseSource = Type.Object({ noise: noiseKinds }, { additionalProperties: false });

// A bank of decaying sine partials: a struck bar, a bell, a metal click. Each partial rings on its own, so a
// hit has a body that an oscillator plus an envelope cannot give.
const modesSource = Type.Object(
  {
    modes: Type.Array(numOrRange(20, 20000, { unit: 'Hz' }), { minItems: 1, maxItems: 16, ...ui({ group: 'Source', help: 'One frequency per partial.' }) }),
    decay: numOrRange(0.002, 10, { default: 0.2, unit: 's', step: 0.005, group: 'Source', help: 'How long the lowest partial rings.' }),
    tilt: Type.Optional(Type.Number({ minimum: 0, maximum: 4, default: 0, ...ui({ widget: 'dial', step: 0.05, group: 'Source', help: 'Higher partials die faster by this much.' }) })),
  },
  { additionalProperties: false },
);

const filterStage = Type.Object(
  {
    filter: Type.Union([Type.Literal('lowpass'), Type.Literal('highpass'), Type.Literal('bandpass'), Type.Literal('notch'), Type.Literal('peaking')], ui({ widget: 'segments' })),
    freq: numOrRange(20, 20000, { unit: 'Hz' }),
    q: Type.Optional(numOrRange(0.1, 40, { default: 0.7, step: 0.1 })),
    glideTo: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 16, ...ui({ widget: 'dial', step: 0.01, help: 'Cutoff at the end of the sweep, as a multiple of freq.' }) })),
    glideTime: Type.Optional(Type.Number({ minimum: 0, maximum: 10, ...ui({ widget: 'dial', unit: 's', step: 0.005 }) })),
    gain: Type.Optional(Type.Number({ minimum: -24, maximum: 24, ...ui({ widget: 'dial', unit: 'dB', help: 'Boost or cut, for peaking only.' }) })),
  },
  { additionalProperties: false },
);

const envelopeStage = Type.Object(
  {
    envelope: Type.Object(
      {
        attack: numOrRange(0, 5, { default: 0.005, unit: 's', step: 0.001 }),
        hold: Type.Optional(numOrRange(0, 5, { default: 0, unit: 's', step: 0.001 })),
        decay: numOrRange(0.001, 10, { default: 0.2, unit: 's', step: 0.005 }),
        curve: Type.Optional(Type.Union([Type.Literal('exp'), Type.Literal('linear')], { default: 'exp', ...ui({ widget: 'segments' }) })),
      },
      { additionalProperties: false, ...ui({ widget: 'curve' }) },
    ),
  },
  { additionalProperties: false },
);

const gainStage = Type.Object({ gain: numOrRange(-60, 24, { unit: 'dB', step: 0.5 }) }, { additionalProperties: false });
const driveStage = Type.Object({ drive: numOrRange(0, 1, { default: 0.3, step: 0.01, help: 'Soft clipping: 0 clean, 1 crushed.' }) }, { additionalProperties: false });
const delayStage = Type.Object(
  {
    delay: Type.Object(
      {
        time: numOrRange(0.001, 1, { default: 0.1, unit: 's', step: 0.001 }),
        feedback: Type.Optional(Type.Number({ minimum: 0, maximum: 0.95, default: 0.3, ...ui({ widget: 'slider', step: 0.01 }) })),
        mix: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.5, ...ui({ widget: 'slider', step: 0.01 }) })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const panStage = Type.Object({ pan: numOrRange(-1, 1, { step: 0.05, help: '-1 left, 1 right.' }) }, { additionalProperties: false });

const layer = Type.Object(
  {
    from: Type.Union([oscSource, noiseSource, modesSource], ui({ group: 'Source' })),
    then: Type.Optional(Type.Array(Type.Union([filterStage, envelopeStage, gainStage, driveStage, delayStage, panStage]), ui({ group: 'Chain', help: 'Shapers run in order.' }))),
    at: Type.Optional(numOrRange(0, 10, { default: 0, unit: 's', step: 0.001, group: 'Timing', help: 'When the layer starts, from the start of the sound.' })),
    repeat: Type.Optional(
      Type.Object(
        {
          count: Type.Integer({ minimum: 2, maximum: 64, ...ui({ widget: 'number' }) }),
          every: numOrRange(0.005, 2, { unit: 's', step: 0.001 }),
          falloff: Type.Optional(Type.Number({ minimum: 0, maximum: 24, default: 0, ...ui({ widget: 'dial', unit: 'dB', help: 'Each repeat is this much quieter than the one before.' }) })),
        },
        { additionalProperties: false, ...ui({ group: 'Timing', help: 'Play the layer again and again: a ratchet, footsteps in a run, droplets.' }) },
      ),
    ),
  },
  { additionalProperties: false },
);

const synth = Type.Object(
  {
    type: Type.Literal('synth'),
    length: Type.Number({ minimum: 0.01, maximum: 30, default: 0.5, ...ui({ widget: 'slider', unit: 's', step: 0.01, group: 'Source' }) }),
    layers: Type.Record(Type.String({ minLength: 1 }), layer, ui({ group: 'Layers', help: 'Named layers that play together.' })),
    reverb: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0, ...ui({ widget: 'slider', step: 0.01, group: 'Mix', help: 'How much goes to the shared reverb.' }) })),
  },
  { additionalProperties: false },
);

const sample = Type.Object(
  {
    type: Type.Literal('sample'),
    file: Type.String({ minLength: 1, ...ui({ help: 'A file in assets/.' }) }),
    start: Type.Optional(Type.Number({ minimum: 0, default: 0, ...ui({ unit: 's' }) })),
    end: Type.Optional(Type.Number({ minimum: 0, ...ui({ unit: 's' }) })),
    loop: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

const pick = Type.Object(
  {
    type: Type.Literal('pick'),
    from: Type.Array(Type.String({ ...ref('sound') }), { minItems: 1, ...ui({ help: 'Other sounds; one is chosen each play.' }) }),
    mode: Type.Optional(Type.Union([Type.Literal('random'), Type.Literal('shuffle'), Type.Literal('sequence')], { default: 'random', ...ui({ widget: 'segments' }) })),
  },
  { additionalProperties: false },
);

const code = Type.Object(
  {
    type: Type.Literal('code'),
    generator: Type.String({ minLength: 1, ...ui({ help: 'A generator registered in code with registerGenerator.' }) }),
    knobs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), ui({ help: 'Values for the generator’s own schema.' }))),
  },
  { additionalProperties: false },
);

export const soundSchema = Type.Object(
  {
    kind: Type.Literal('sound'),
    note: Type.Optional(Type.String()),
    // 'bus' is not a config kind (buses live inside the mixer file), so there is no x-ref: the engine reports an
    // unknown bus once and plays on master.
    bus: Type.Optional(Type.String({ default: 'sfx', ...ui({ widget: 'text', group: 'Mix', help: 'A bus from the mixer.' }) })),
    level: Type.Optional(Type.Number({ minimum: -60, maximum: 12, default: 0, ...ui({ widget: 'slider', unit: 'dB', step: 0.5, group: 'Mix' }) })),
    pitch: Type.Optional(numOrRange(0.25, 4, { default: 1, step: 0.01, group: 'Mix', help: 'Speed multiplier. A range is drawn each play.' })),
    loop: Type.Optional(Type.Boolean({ default: false, ...ui({ group: 'Mix' }) })),
    limit: Type.Optional(
      Type.Object(
        {
          minGap: Type.Optional(Type.Number({ minimum: 0, maximum: 5, default: 0, ...ui({ widget: 'dial', unit: 's', step: 0.005, help: 'Ignore a play that comes sooner than this after the last.' }) })),
          voices: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, default: 8, ...ui({ widget: 'number', help: 'Most copies playing at once.' }) })),
          over: Type.Optional(Type.Union([Type.Literal('steal-oldest'), Type.Literal('skip')], { default: 'steal-oldest', ...ui({ widget: 'segments' }) })),
        },
        { additionalProperties: false, ...ui({ group: 'Limits' }) },
      ),
    ),
    spatial: Type.Optional(
      Type.Object(
        {
          ref: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 5, ...ui({ widget: 'dial', unit: 'm', help: 'Full level inside this distance.' }) })),
          max: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 80, ...ui({ widget: 'dial', unit: 'm', help: 'Silent beyond this distance.' }) })),
          airLowpass: Type.Optional(Type.Boolean({ default: true, ...ui({ help: 'Distant sounds lose their highs.' }) })),
        },
        { additionalProperties: false, ...ui({ group: 'Space' }) },
      ),
    ),
    source: Type.Union([synth, sample, pick, code]),
  },
  { additionalProperties: false, title: 'Hull sound' },
);

export type Sound = Static<typeof soundSchema>;
