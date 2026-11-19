import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startSignIn } from './account.ts';
import { createSettingsStore, NEEDS_ACCOUNT } from './agentSettings.ts';

const crypto = { available: async () => true, encrypt: async (s: string) => Buffer.from('x' + s).toString('base64'), decrypt: async (b: string) => Buffer.from(b, 'base64').toString().slice(1) };

describe('Hull account sign-in', () => {
  it('runs the PKCE code flow over a loopback redirect and returns the token', async () => {
    let seen: { body?: Record<string, string>; authorize?: URL } = {};
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://acct.test/oauth/token');
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ access_token: 'hull_abc', token_type: 'Bearer', account: { email: 'a@example.com' } }), { status: 200 });
    }) as typeof fetch;
    // The "browser": reads the authorize URL and comes straight back to the loopback address with a code.
    const s = await startSignIn({ server: 'http://acct.test/', fetch: fakeFetch, open: async (u) => {
      const a = new URL(u); seen.authorize = a;
      const back = new URL(a.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'c1'); back.searchParams.set('state', a.searchParams.get('state')!);
      const page = await fetch(back); expect(await page.text()).toContain('Signed in');
    } });
    await expect(s.done).resolves.toEqual({ token: 'hull_abc', email: 'a@example.com' });
    const a = seen.authorize!;
    expect(a.origin + a.pathname).toBe('http://acct.test/oauth/authorize');
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The verifier hashes to the challenge that went to the browser.
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(seen.body!['code_verifier']!).digest('base64url')).toBe(a.searchParams.get('code_challenge'));
    expect(seen.body).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_id: 'hull', redirect_uri: a.searchParams.get('redirect_uri') });
  });

  it('refuses a callback with the wrong state, and reports a refusal', async () => {
    const s = await startSignIn({ server: 'http://acct.test', fetch: (async () => new Response('{}')) as typeof fetch, open: async (u) => {
      const back = new URL(new URL(u).searchParams.get('redirect_uri')!);
      back.searchParams.set('state', 'forged'); back.searchParams.set('code', 'x');
      expect((await fetch(back)).status).toBe(400);
      back.searchParams.set('state', new URL(u).searchParams.get('state')!); back.searchParams.delete('code'); back.searchParams.set('error', 'access_denied');
      await fetch(back);
    } });
    await expect(s.done).rejects.toThrow(/cancelled in the browser/);
  });
});

describe('account settings', () => {
  it('keeps the token encrypted, gives the builder the account as Anthropic, and forgets it on sign-out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hull-acct-'));
    try {
      const store = createSettingsStore({ dataDir: dir, crypto, env: { HULL_BACKEND_URL: 'http://acct.test/' } });
      await store.set({ provider: 'account' });
      expect(await store.needs({})).toBe(NEEDS_ACCOUNT);
      expect((await store.get()).account).toEqual({ url: 'http://acct.test', email: null });
      const got = await store.setAccount({ url: 'http://acct.test', email: 'a@example.com', token: 'hull_tok' });
      expect(got).toMatchObject({ provider: 'account', hasKey: true, account: { url: 'http://acct.test', email: 'a@example.com' } });
      expect(JSON.stringify(got)).not.toContain('hull_tok');
      expect(readFileSync(join(dir, 'agent-settings.json'), 'utf8')).not.toContain('hull_tok');
      expect(await store.env({ ANTHROPIC_API_KEY: 'mine' })).toMatchObject({ ANTHROPIC_API_KEY: 'hull_tok', ANTHROPIC_BASE_URL: 'http://acct.test' });
      // Saving other settings keeps the sign-in; a new server address forgets it.
      await store.set({ provider: 'account', model: 'claude-sonnet-5-5' });
      expect((await store.get()).account?.email).toBe('a@example.com');
      expect(await store.clearAccount()).toEqual({ url: 'http://acct.test', token: 'hull_tok' });
      expect(await store.needs({})).toBe(NEEDS_ACCOUNT);
      await store.setAccount({ url: 'http://acct.test', email: 'a@example.com', token: 'hull_tok' });
      await store.set({ provider: 'account', accountUrl: 'https://other.test' });
      expect((await store.get()).account).toEqual({ url: 'https://other.test', email: null });
      await expect(store.set({ provider: 'account', accountUrl: 'not a url' })).rejects.toThrow(/http/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
