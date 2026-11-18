import { config, num, tunables } from 'hull';

// Numbers one piece of code owns live here, so the Inspector can turn them while the game runs. Numbers about the
// layout and the round are shared by several pieces and vary by file, so they are in config/tuning/arena.json.

export const player = tunables('player', {
  runSpeed: num(7, { min: 1, max: 20, step: 0.5, unit: 'm/s', widget: 'dial', help: 'Top speed on foot.' }),
  groundAccel: num(60, { min: 5, max: 200, step: 1, unit: 'm/s²', widget: 'dial', help: 'How quickly the player reaches top speed or stops on the ground.' }),
  airControl: num(0.5, { min: 0, max: 1, step: 0.05, widget: 'slider', help: 'Share of ground acceleration kept in the air.' }),
  jumpHeight: num(1.6, { min: 0.3, max: 4, step: 0.1, unit: 'm', widget: 'dial', help: 'Height of a full jump from flat ground.' }),
  gravity: num(28, { min: 5, max: 80, step: 1, unit: 'm/s²', widget: 'dial' }),
  coyoteTime: num(0.12, { min: 0, max: 0.4, step: 0.01, unit: 's', widget: 'slider', help: 'How long after walking off a ledge a jump still counts.' }),
  radius: num(0.4, { min: 0.2, max: 1, step: 0.05, unit: 'm' }),
  height: num(1.8, { min: 0.8, max: 3, step: 0.05, unit: 'm' }),
});

export const camera = tunables('camera', {
  distance: num(9, { min: 3, max: 25, step: 0.5, unit: 'm', widget: 'dial', help: 'How far behind the player the camera sits.' }),
  height: num(6, { min: 1, max: 20, step: 0.5, unit: 'm', widget: 'dial', help: 'How far above the player the camera sits.' }),
  lookHeight: num(1, { min: 0, max: 3, step: 0.1, unit: 'm', help: 'Height above the feet the camera aims at.' }),
  follow: num(6, { min: 0.5, max: 30, step: 0.5, unit: '1/s', widget: 'slider', help: 'How tightly the camera follows. Higher is stiffer.' }),
  fov: num(55, { min: 20, max: 110, step: 1, unit: 'deg', widget: 'slider' }),
});

export const sfx = tunables('sfx', {
  strideLength: num(1.9, { min: 0.5, max: 5, step: 0.1, unit: 'm', help: 'Distance run between two footsteps.' }),
  landMinSpeed: num(4, { min: 0, max: 20, step: 0.5, unit: 'm/s', help: 'Landing slower than this makes no sound.' }),
  landMaxSpeed: num(16, { min: 1, max: 40, step: 0.5, unit: 'm/s', help: 'Landing at this speed or faster is the loudest thud.' }),
});

export const pickup = tunables('pickup', {
  spinSpeed: num(2.5, { min: 0, max: 12, step: 0.1, unit: 'rad/s', widget: 'dial' }),
  bobHeight: num(0.15, { min: 0, max: 1, step: 0.01, unit: 'm' }),
  bobSpeed: num(3, { min: 0, max: 12, step: 0.1, unit: 'rad/s' }),
  collectRadius: num(0.9, { min: 0.2, max: 3, step: 0.05, unit: 'm', help: 'How close the player must be to collect.' }),
  points: num(1, { min: 1, max: 100, step: 1 }),
});

/** One number from config/tuning/arena.json. Read each time, so an edit applies at once. */
export function arena(key: string): number {
  const v = config.get('tuning', 'arena')[key];
  if (typeof v !== 'number') throw new Error(`config/tuning/arena.json: "${key}" is missing or not a number`);
  return v;
}
