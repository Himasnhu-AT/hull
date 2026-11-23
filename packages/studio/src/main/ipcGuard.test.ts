import { describe, expect, it } from 'vitest';
import { isAppPage, isOwnWebRequest, isWebLink } from './ipcGuard.ts';

describe('ipcGuard', () => {
  const built = { rendererDir: '/App/out/renderer' };
  const dev = { appUrl: 'http://127.0.0.1:5305/', rendererDir: '/App/out/renderer' };
  it('accepts the app page and nothing else', () => {
    expect(isAppPage('file:///App/out/renderer/index.html', built)).toBe(true);
    expect(isAppPage('file:///tmp/evil.html', built)).toBe(false);
    expect(isAppPage('http://127.0.0.1:5400/', built)).toBe(false); // the game's iframe
    expect(isAppPage('http://127.0.0.1:5305/#/x', dev)).toBe(true);
    expect(isAppPage('http://127.0.0.1:5400/', dev)).toBe(false);
    expect(isAppPage('https://evil.example/', dev)).toBe(false);
    expect(isAppPage('not a url', dev)).toBe(false);
  });
  it('opens only web links outside the app', () => {
    expect(isWebLink('https://marl.studio/x')).toBe(true);
    expect(isWebLink('file:///etc/passwd')).toBe(false);
    expect(isWebLink('smb://host/share')).toBe(false);
  });
  it('web mode answers only its own host and origin', () => {
    expect(isOwnWebRequest({ host: '127.0.0.1:5305' }, 5305)).toBe(true);
    expect(isOwnWebRequest({ host: '127.0.0.1:5305', origin: 'http://127.0.0.1:5305' }, 5305)).toBe(true);
    expect(isOwnWebRequest({ host: '127.0.0.1:5305', origin: 'https://evil.example' }, 5305)).toBe(false);
    expect(isOwnWebRequest({ host: 'rebind.evil.example:5305' }, 5305)).toBe(false);
  });
});
