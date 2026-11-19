import { describe, expect, it } from 'vitest';
import { cleanLaunchQuery, withLaunch } from './launch.ts';

describe('launch options', () => {
  it('cleans a query', () => {
    expect(cleanLaunchQuery('?start=camp&look=night')).toBe('start=camp&look=night');
    expect(cleanLaunchQuery('  start=camp # note ')).toBe('start=camp');
    expect(cleanLaunchQuery('hull-paused&play=expedition')).toBe('hull-paused&play=expedition');
    expect(cleanLaunchQuery('a=1&&=x&b=%E0%A4%A')).toBe('a=1');
    expect(cleanLaunchQuery('')).toBe('');
  });
  it('applies to a url', () => {
    expect(withLaunch('http://h/', 'start=camp')).toBe('http://h/?start=camp');
    expect(withLaunch('http://h/?x=1', 'start=camp')).toBe('http://h/?x=1&start=camp');
    expect(withLaunch('http://h/', '')).toBe('http://h/');
  });
});
