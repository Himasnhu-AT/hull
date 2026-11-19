// Every tunable of the tether gear and the soldier in one place, read as `CFG.hook.range`. The numbers are Hull
// tunables (tuning.ts, with their values in config/tuning/*.json): each property below is a getter over a live cell, so
// an Inspector edit shows on the next step. Lists of numbers (the rope fan angles) are plain constants.
import * as T from './tuning';

/** The live block `t` plus fixed extras: a copy of its getters, so a tunable edit still reaches it. */
function withConst<A extends object, B extends object>(t: A, c: B): A & B {
  return Object.defineProperties({} as A & B, { ...Object.getOwnPropertyDescriptors(t), ...Object.getOwnPropertyDescriptors(c) });
}

export const CFG = {
  physicsHz: 120,
  get gravity(): number { return T.body.gravity; },
  get drag(): number { return T.body.drag; },
  get hardCap(): number { return T.body.hardCap; },
  get radius(): number { return T.body.radius; },
  get modelLift(): number { return T.body.modelLift; },
  hook: T.hook,
  reel: T.reel,
  gas: T.gas,
  air: T.air,
  ground: T.ground,
  impact: T.impact,
  wire: T.wire,
  horse: T.horse,
  perch: T.perch,
  wall: T.wall,
  hang: T.hang,
  flow: T.flow,
  kill: T.kill,
  release: T.release,
  aim: T.aim,
  keys: withConst(T.keys, { yawOffsets: [0.12,0.38,0.65,0.95,1.3], pitches: [0.1,0.32,0.55,0.8], pitchesHigh: [-0.45,-0.2,0.05,0.3] }),
  cam: T.cam,
  combat: withConst(T.combat, { napeAngle: { get side(): number { return T.combat.napeAngleSide; } } }),
};
