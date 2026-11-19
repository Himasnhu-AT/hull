// Every number that tunes the soldier, the gear and the titans, as Hull tunables. The Inspector turns them while the
// game runs; config/tuning/<block>.json holds the project's values (one file per block) and wins over the literals
// here. Generated once from AOTT's CFG and the titan constants, then kept by hand.
import { num, tunables } from 'hull';

export const hook = tunables('hook', {
  range: num(115, { min: 0, max: 460, step: 0.5, help: "max anchor distance from the launcher" }),
  speed: num(340, { min: 0, max: 1360, step: 1, help: "anchor flight speed" }),
  retract: num(420, { min: 0, max: 1680, step: 1, help: "wire wind-back speed after release / miss" }),
  minLen: num(1.8, { min: 0, max: 7.2, step: 0.01, help: "the reel stops this close to an anchor" }),
  spread: num(0.022, { min: 0, max: 0.088, step: 0.0005, help: "radians: both-hooks fire either side of the aim point" }),
});

export const reel = tunables('reel', {
  accel: num(38, { min: 0, max: 152, step: 0.5, help: "the gas-driven winch, always running while anchored" }),
  maxIn: num(42, { min: 0, max: 168, step: 0.5 }),
  boostAccel: num(84, { min: 0, max: 336, step: 0.5, help: "with the gas trigger held" }),
  boostMaxIn: num(72, { min: 0, max: 288, step: 0.5 }),
  near: num(7, { min: 0, max: 28, step: 0.1, help: "reel tapers inside this distance (no face-plants)" }),
  arrive: num(13, { min: 0, max: 52, step: 0.1, help: "head-on arrival speed / gas-brake decel" }),
  brake: num(65, { min: 0, max: 260, step: 0.5 }),
  brakeMax: num(150, { min: 0, max: 600, step: 0.5 }),
  brakeHard: num(420, { min: 0, max: 1680, step: 1, help: "late (a trunk swung into view close up): the vents brake as hard as it takes, up to this" }),
  twinShare: num(0.62, { min: 0, max: 2.48, step: 0.01, help: "each wire's share when both are anchored" }),
});

export const gas = tunables('gas', {
  capacity: num(1, { min: 0, max: 4, step: 0.01 }),
  boostAccel: num(30, { min: 0, max: 120, step: 0.5, help: "free-flight thrust" }),
  hookedBoostAccel: num(13, { min: 0, max: 52, step: 0.1, help: "extra steering thrust while reeling" }),
  dashDv: num(16, { min: 0, max: 64, step: 0.1 }),
  dashCost: num(0.035, { min: 0, max: 0.14, step: 0.0005 }),
  dashCooldown: num(0.45, { min: 0, max: 1.8, step: 0.005 }),
  boostRate: num(0.05, { min: 0, max: 0.2, step: 0.005, help: "per second while boosting" }),
  reelRate: num(0.004, { min: 0, max: 0.016, step: 0.0005, help: "per second per anchored wire" }),
  fireCost: num(0.003, { min: 0, max: 0.012, step: 0.0005 }),
});

export const air = tunables('air', {
  control: num(8.5, { min: 0, max: 34, step: 0.1 }),
  pump: num(12, { min: 0, max: 48, step: 0.1 }),
  carve: num(10, { min: 0, max: 40, step: 0.1 }),
  carveGas: num(32, { min: 0, max: 128, step: 0.5 }),
});

export const ground = tunables('ground', {
  run: num(12.5, { min: 0, max: 50, step: 0.1 }),
  accel: num(95, { min: 0, max: 380, step: 0.5 }),
  skid: num(22, { min: 0, max: 88, step: 0.5 }),
  brake: num(45, { min: 0, max: 180, step: 0.5 }),
  maxLateral: num(16, { min: 0, max: 64, step: 0.1 }),
  jump: num(7.8, { min: 0, max: 31.2, step: 0.1 }),
  coyote: num(0.12, { min: 0, max: 0.48, step: 0.005 }),
});

export const impact = tunables('impact', {
  feel: num(11, { min: 0, max: 44, step: 0.1 }),
  wall: num(17, { min: 0, max: 68, step: 0.1 }),
  stun: num(48, { min: 0, max: 192, step: 0.5 }),
});

export const wire = tunables('wire', {
  snapSpeed: num(7, { min: 0, max: 28, step: 0.1 }),
  rebound: num(0.08, { min: 0, max: 0.32, step: 0.005 }),
  slipFrom: num(2.5, { min: 0, max: 10, step: 0.01 }),
  slipDecel: num(85, { min: 0, max: 340, step: 0.5 }),
});

export const horse = tunables('horse', {
  mountRadius: num(2.6, { min: 0, max: 10.4, step: 0.01 }),
  mountTime: num(0.72, { min: 0, max: 2.88, step: 0.01 }),
  maxMountSpeed: num(24, { min: 0, max: 96, step: 0.5 }),
  leap: num(9.5, { min: 0, max: 38, step: 0.1 }),
  ropeLeap: num(5, { min: 0, max: 20, step: 0.1 }),
  leapForward: num(2, { min: 0, max: 8, step: 0.01 }),
});

export const perch = tunables('perch', {
  reach: num(6, { min: 0, max: 24, step: 0.1 }),
  maxSpeed: num(25, { min: 0, max: 100, step: 0.5 }),
  slide: num(2.5, { min: 0, max: 10, step: 0.01 }),
  letGo: num(0.6, { min: 0, max: 2.4, step: 0.01 }),
  climbReach: num(12, { min: 0, max: 48, step: 0.1 }),
});

export const wall = tunables('wall', {
  runSpeed: num(17, { min: 0, max: 68, step: 0.1 }),
  runBoost: num(27, { min: 0, max: 108, step: 0.5 }),
  runAccel: num(34, { min: 0, max: 136, step: 0.5 }),
  runDrag: num(5, { min: 0, max: 20, step: 0.1 }),
  runMin: num(4.5, { min: 0, max: 18, step: 0.1 }),
  runTime: num(2.4, { min: 0, max: 9.6, step: 0.01 }),
  runFade: num(1.3, { min: 0, max: 5.2, step: 0.01 }),
  runLift: num(3, { min: 0, max: 12, step: 0.1 }),
  kick: num(10.5, { min: 0, max: 42, step: 0.1 }),
  kickUp: num(8.5, { min: 0, max: 34, step: 0.1 }),
  kickAlong: num(4, { min: 0, max: 16, step: 0.1 }),
  runUp: num(0.85, { min: 0, max: 3.4, step: 0.01 }),
  runUpMax: num(17, { min: 0, max: 68, step: 0.1 }),
  climb: num(4.8, { min: 0, max: 19.2, step: 0.1 }),
  climbGas: num(10, { min: 0, max: 40, step: 0.1 }),
  shuffle: num(3.6, { min: 0, max: 14.4, step: 0.1 }),
  slide: num(6, { min: 0, max: 24, step: 0.1 }),
  grip: num(7, { min: 0, max: 28, step: 0.1 }),
  mantle: num(2.6, { min: 0, max: 10.4, step: 0.01 }),
});

export const hang = tunables('hang', {
  winch: num(7, { min: 0, max: 28, step: 0.1 }),
  lower: num(9, { min: 0, max: 36, step: 0.1 }),
  swing: num(10, { min: 0, max: 40, step: 0.1 }),
  damp: num(1.6, { min: 0, max: 6.4, step: 0.01 }),
  dampHeld: num(0.25, { min: 0, max: 1, step: 0.005 }),
});

export const flow = tunables('flow', {
  killGas: num(0.14, { min: 0, max: 0.56, step: 0.005 }),
  rush: num(3.5, { min: 0, max: 14, step: 0.1 }),
  rushReel: num(1.25, { min: 0, max: 5, step: 0.01 }),
});

export const kill = tunables('kill', {
  slowmo: num(0.9, { min: 0, max: 3.6, step: 0.01, help: "the nape-cut moment" }),
  camTime: num(1.05, { min: 0, max: 4.2, step: 0.01 }),
  camCooldown: num(2.5, { min: 0, max: 10, step: 0.01 }),
});

export const release = tunables('release', {
  boost: num(7, { min: 0, max: 28, step: 0.1, help: "a well-timed release (bottom of the swing) slings you out" }),
  lift: num(3, { min: 0, max: 12, step: 0.1 }),
  flipTime: num(0.6, { min: 0, max: 2.4, step: 0.01 }),
});

export const aim = tunables('aim', {
  cone: num(0.55, { min: 0, max: 2.2, step: 0.01, help: "ropes go where you face (cos of the cone edge)" }),
  facingWeight: num(3.2, { min: 0, max: 12.8, step: 0.1 }),
  banTime: num(4, { min: 0, max: 16, step: 0.1 }),
});

export const keys = tunables('keys', {
  turnGround: num(2.7, { min: 0, max: 10.8, step: 0.01, help: "rad/s heading turn from ← →" }),
  turnAir: num(1.9, { min: 0, max: 7.6, step: 0.01 }),
  turnRope: num(1.6, { min: 0, max: 6.4, step: 0.01 }),
  followRate: num(1.1, { min: 0, max: 4.4, step: 0.01, help: "airborne heading eases toward the flight direction" }),
  payout: num(7, { min: 0, max: 28, step: 0.1, help: "m/s the wire pays out while holding ↓ on a rope" }),
  releaseLift: num(2.2, { min: 0, max: 8.8, step: 0.01, help: "m/s upward flick when letting go at speed" }),
});

export const cam = tunables('cam', {
  dist: num(4.4, { min: 0, max: 17.6, step: 0.1 }),
  height: num(0.95, { min: 0, max: 3.8, step: 0.01 }),
  side: num(0.6, { min: 0, max: 2.4, step: 0.01 }),
  fov: num(70, { min: 0, max: 280, step: 0.5 }),
  fovMax: num(98, { min: 0, max: 392, step: 0.5 }),
  sens: num(0.0021, { min: 0, max: 0.0084, step: 0.0005 }),
  lagRate: num(22, { min: 0, max: 88, step: 0.5 }),
  distPerSpeed: num(0.028, { min: 0, max: 0.2, step: 0.001, help: "pull back per m/s of speed" }),
  distSpeedCap: num(90, { min: 0, max: 360, step: 1, help: "speed above this pulls no further" }),
  distRate: num(3, { min: 0, max: 12, step: 0.1, help: "how fast the distance settles (1/s)" }),
  clearIn: num(12, { min: 0, max: 48, step: 0.5, help: "gliding in off a wall (1/s)" }),
  clearOut: num(4, { min: 0, max: 16, step: 0.5, help: "gliding back out once the way is clear (1/s)" }),
  loomDist: num(1.2, { min: 0, max: 5, step: 0.05, help: "extra distance under a looming titan" }),
  loomLower: num(0.55, { min: 0, max: 2.2, step: 0.05, help: "pivot drops this far under a looming titan" }),
  rollPerSpeed: num(0.0048, { min: 0, max: 0.02, step: 0.0002, help: "bank into a swing, radians per m/s" }),
  rollMax: num(0.26, { min: 0, max: 1, step: 0.01 }),
  wallRollMax: num(0.24, { min: 0, max: 1, step: 0.01, help: "the frame leans away from a wall you run on" }),
  fovSpeedLo: num(12, { min: 0, max: 48, step: 0.5, help: "the lens starts opening at this speed" }),
  fovSpeedHi: num(85, { min: 0, max: 340, step: 0.5, help: "fully open at this speed" }),
  punchFov: num(8, { min: 0, max: 32, step: 0.5, help: "snap-zoom when a rope bites" }),
  wallRunFov: num(6, { min: 0, max: 24, step: 0.5 }),
  rushFov: num(3, { min: 0, max: 12, step: 0.5 }),
});

// Holdout's wave clock (hull/kits waves.ts reads this block live) and what each of the four scripted waves holds.
export const waves = tunables('waves', {
  clearPause: num(4, { min: 0, max: 16, step: 0.1, help: "seconds from 'wave cleared' to the next wave" }),
  clockBase: num(90, { min: 0, max: 360, step: 1, help: "a wave marches on after this many seconds minus clockPerWave each wave" }),
  clockPerWave: num(4, { min: 0, max: 16, step: 0.1 }),
  clockMin: num(45, { min: 0, max: 180, step: 1 }),
  capBase: num(6, { min: 0, max: 24, step: 1, help: "most titans standing while stragglers or a clock wave may still come" }),
  capPerWave: num(2, { min: 0, max: 8, step: 0.5 }),
  capMax: num(22, { min: 0, max: 88, step: 1 }),
  trickleBase: num(12, { min: 0, max: 48, step: 0.5, help: "seconds between stragglers" }),
  trickleDrop: num(0.8, { min: 0, max: 3.2, step: 0.05 }),
  trickleMin: num(4, { min: 0, max: 16, step: 0.5 }),
  firstTrickle: num(6, { min: 0, max: 24, step: 0.5 }),
  firstDelay: num(2.5, { min: 0, max: 10, step: 0.1, help: "the first wave after the title card" }),
  growth: num(0.35, { min: 0, max: 1.4, step: 0.01, help: "each wave past the table grows by this share" }),
  openZMin: num(45, { min: 0, max: 400, step: 1, help: "wave 1 walks up to the wall: nearest and farthest z, widest x" }),
  openZMax: num(100, { min: 0, max: 400, step: 1 }),
  openXMax: num(85, { min: 0, max: 340, step: 1 }),
  breachZMin: num(45, { min: 0, max: 400, step: 1, help: "with the gate down: the field box" }),
  breachZMax: num(170, { min: 0, max: 680, step: 1 }),
  breachXMax: num(130, { min: 0, max: 520, step: 1 }),
});

const wave = (field: number, forest: number, town: number, abnormal: number, lo: number, hi: number) => ({
  field: num(field, { min: 0, max: 40, step: 1 }),
  forest: num(forest, { min: 0, max: 40, step: 1 }),
  town: num(town, { min: 0, max: 40, step: 1 }),
  abnormal: num(abnormal, { min: 0, max: 20, step: 1 }),
  sizeMin: num(lo, { min: 2, max: 20, step: 0.5, unit: 'm' }),
  sizeMax: num(hi, { min: 2, max: 30, step: 0.5, unit: 'm' }),
});
export const wave1 = tunables('wave1', wave(4, 0, 0, 0, 4, 9));
export const wave2 = tunables('wave2', wave(3, 3, 0, 1, 5, 13));
export const wave3 = tunables('wave3', wave(2, 0, 3, 1, 4, 12));
export const wave4 = tunables('wave4', wave(1, 6, 0, 2, 6, 15));

// Supply depots: stand in one until it has refilled you.
export const depot = tunables('depot', {
  dwell: num(0.8, { min: 0, max: 5, step: 0.05, unit: 's', help: "seconds to stand inside before it refills you" }),
  cooldown: num(2, { min: 0, max: 10, step: 0.1, unit: 's', help: "after a refill, how long until the next" }),
  gas: num(1, { min: 0, max: 1, step: 0.05, help: "gas is brought up to this share of full" }),
  blades: num(1, { min: 0, max: 1, step: 0.05, help: "spare blades are brought up to this share" }),
  bandages: num(1, { min: 0, max: 1, step: 0.05, help: "hit points are brought up to this share" }),
});

// What a hit on each part of a titan does, and the soldier's hit points.
export const zones = tunables('zones', {
  shallow: num(10, { min: 0, max: 40, step: 0.5, help: "a cut above this wounds (eye, limbs, nape)" }),
  bodyShallow: num(20, { min: 0, max: 80, step: 0.5, help: "a cut on the body wounds above this" }),
  eyeBlind: num(25, { min: 0, max: 100, step: 0.5, help: "a cut this deep puts an eye out" }),
  blindTime: num(6, { min: 0, max: 24, step: 0.5, unit: 's' }),
  ankleCut: num(40, { min: 0, max: 160, step: 0.5, help: "a cut this deep through an ankle takes the lower leg" }),
  legCut: num(110, { min: 0, max: 440, step: 0.5, help: "same, through the shin" }),
  armCut: num(140, { min: 0, max: 560, step: 0.5, help: "a cut this deep takes the forearm (arm or hand)" }),
  napeCoverStrength: num(0.7, { min: 0, max: 1, step: 0.01, help: "a fully hunched nape takes this share off the cut" }),
  napeCovered: num(0.3, { min: 0, max: 1, step: 0.01, help: "cover above this counts as covered" }),
  regenDelay: num(4, { min: 0, max: 16, step: 0.1, unit: 's', help: "soldier: quiet seconds before hit points come back" }),
  regenRate: num(0.04, { min: 0, max: 0.16, step: 0.005, help: "soldier: share of full per second" }),
});

export const combat = tunables('combat', {
  slashTime: num(0.3, { min: 0, max: 1.2, step: 0.005 }),
  reach: num(2.6, { min: 0, max: 10.4, step: 0.01 }),
  dmgBase: num(40, { min: 0, max: 160, step: 0.5 }),
  dmgPerMs: num(12.5, { min: 0, max: 50, step: 0.1 }),
  wear: num(0.11, { min: 0, max: 0.44, step: 0.005 }),
  spinMinSpeed: num(16, { min: 0, max: 64, step: 0.1 }),
  spinInterval: num(0.09, { min: 0, max: 0.36, step: 0.005 }),
  swapTime: num(0.55, { min: 0, max: 2.2, step: 0.01 }),
  spares: num(4, { min: 0, max: 16, step: 0.1 }),
  grabEscapePerPress: num(0.2, { min: 0, max: 0.8, step: 0.005 }),
  grabDecay: num(0.18, { min: 0, max: 0.72, step: 0.005 }),
  swoopRange: num(45, { min: 0, max: 180, step: 0.5 }),
  swoop: num(36, { min: 0, max: 144, step: 0.5 }),
  swoopBoost: num(54, { min: 0, max: 216, step: 0.5 }),
  swoopGain: num(5.5, { min: 0, max: 22, step: 0.1 }),
  swoopMax: num(70, { min: 0, max: 280, step: 0.5 }),
  swoopTrack: num(2.5, { min: 0, max: 10, step: 0.01 }),
  swoopSteer: num(22, { min: 0, max: 88, step: 0.5 }),
  napeAngleSide: num(0.55, { min: 0, max: 2.2, step: 0.01 }),
  napeWound: num(0.6, { min: 0, max: 2.4, step: 0.01 }),
});

export const body = tunables('body', {
  gravity: num(14.5, { min: 0, max: 58, step: 0.1 }),
  drag: num(0.0023, { min: 0, max: 0.0092, step: 0.0005 }),
  hardCap: num(105, { min: 0, max: 420, step: 0.5 }),
  radius: num(0.5, { min: 0, max: 2, step: 0.01 }),
  modelLift: num(0.4, { min: 0, max: 1.6, step: 0.005 }),
});

export const titan = tunables('titan', {
  windup: num(0.45, { min: 0, max: 1.8, step: 0.005, help: "Seconds of readable wind-up before every grab reach, swat, bite and leap." }),
  grabMaxRelSpeed: num(18, { min: 0, max: 72, step: 0.1, help: "A hand only closes on a player slower than this relative to the hand (m/s)." }),
  grabBlockAfterEscape: num(1.5, { min: 0, max: 6, step: 0.01, help: "No titan grabs for this long after the player cuts free (s)." }),
  leapCooldown: num(8, { min: 0, max: 32, step: 0.1, help: "Minimum time between two leaps of one abnormal (s)." }),
  leapChance: num(0.6, { min: 0, max: 2.4, step: 0.01, help: "Per second while a leap is possible." }),
  leapG: num(24, { min: 0, max: 96, step: 0.5, help: "Gravity of a titan leap (m/s²): titan leaps are heavy." }),
  breachWind: num(1.3, { min: 0, max: 5.2, step: 0.01, help: "The Behemoth gate kick, seconds from when it stands there: wind up." }),
  breachBack: num(2.8, { min: 0, max: 11.2, step: 0.01, help: "Leg drawn back." }),
  breachKick: num(3.22, { min: 0, max: 12.88, step: 0.1, help: "The kick lands." }),
  breachSwing: num(3.3, { min: 0, max: 13.2, step: 0.1, help: "Swing ends." }),
  breachDown: num(4.6, { min: 0, max: 18.4, step: 0.1, help: "Foot set down." }),
  breachVanish: num(5, { min: 0, max: 20, step: 0.1, help: "From here it boils away." }),
  armRegrow: num(12, { min: 0, max: 48, step: 0.1, help: "Seconds until a cut-off forearm has grown back." }),
  legRegrow: num(9, { min: 0, max: 36, step: 0.1, help: "Seconds until a cut-off lower leg has grown back." }),
  grow: num(2.6, { min: 0, max: 10.4, step: 0.01, help: "The new limb pushes out over the last this-many seconds of the regrow." }),
});

