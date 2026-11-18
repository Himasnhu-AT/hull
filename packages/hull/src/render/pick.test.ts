import { describe, expect, it } from 'vitest';
import { backendOrder, choiceFromQuery, webgpuRefusal } from './pick.ts';

describe('backend choice', () => {
  it('tries WebGPU first only when the browser has it, and always ends on WebGL2', () => {
    expect(backendOrder('auto', true)).toEqual(['webgpu', 'webgl2']);
    expect(backendOrder('auto', false)).toEqual(['webgl2']);
  });
  it('a forced backend is the only one tried', () => {
    expect(backendOrder('webgl2', true)).toEqual(['webgl2']);
    expect(backendOrder('webgpu', false)).toEqual(['webgpu']);
  });
  it('reads the query string, ignoring junk', () => {
    expect(choiceFromQuery('?hullBackend=webgpu')).toBe('webgpu');
    expect(choiceFromQuery('?x=1&hullBackend=webgl2')).toBe('webgl2');
    expect(choiceFromQuery('?hullBackend=vulkan')).toBe('auto');
    expect(choiceFromQuery('')).toBe('auto');
  });
  it('refuses a missing, software or small adapter and says why', () => {
    expect(webgpuRefusal({ adapter: null })).toMatch(/no WebGPU adapter/);
    expect(webgpuRefusal({ adapter: { fallback: true, maxStorageBuffers: 10, maxStorageBufferBytes: 1e9 } })).toMatch(/software/);
    expect(webgpuRefusal({ adapter: { fallback: false, maxStorageBuffers: 4, maxStorageBufferBytes: 1e9 } })).toMatch(/4 storage buffers/);
    expect(webgpuRefusal({ adapter: { fallback: false, maxStorageBuffers: 10, maxStorageBufferBytes: 1e9 } })).toBeNull();
  });
});
