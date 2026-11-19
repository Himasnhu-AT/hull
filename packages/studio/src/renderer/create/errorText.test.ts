import { describe, expect, it } from 'vitest';
import { crashText } from './errorText.ts';

describe('crashText', () => {
  it('names the screen and gives the error text', () => {
    const e = new TypeError('Cannot read properties of undefined');
    const t = crashText('Share', e);
    expect(t.what).toContain('Share stopped working');
    expect(t.detail.split('\n')[0]).toBe('TypeError: Cannot read properties of undefined');
  });
  it('takes a thrown string or object', () => {
    expect(crashText('Brief', 'boom').detail).toContain('boom');
    expect(crashText('Brief', { a: 1 }).detail).toContain('{"a":1}');
  });
  it('cuts a very long message', () => {
    expect(crashText('Build', new Error('x'.repeat(1000))).detail.split('\n')[0]!.length).toBeLessThan(430);
  });
});
