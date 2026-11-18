import { num, tunables } from 'hull';

export const cube = tunables('cube', {
  spin: num(1.2, { min: 0, max: 10, unit: 'rad/s', widget: 'dial' }),
});
