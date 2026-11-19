// Which model the builder uses, and its key. In Electron the key is encrypted with safeStorage and kept in userData; the
// page only ever learns whether a key exists. In web mode there is no safe place to keep one, so the environment decides.
// The key is never logged and never part of anything returned to the renderer.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSettings, AgentSettingsInput, BuilderProvider, KeyProvider } from '../shared/agentApi.ts';

/** Electron's safeStorage, reduced to what this needs (so tests can pass a stand-in). */
export interface KeyCrypto { available(): boolean | Promise<boolean>; encrypt(plain: string): string | Promise<string>; decrypt(cipher: string): string | Promise<string> }

/** On disk. `keys` holds one encrypted key per provider; `key` is the single key older versions kept, read as the key of `provider`. */
/** `account` is the Hull account: its server, who signed in, and the app token (encrypted like the keys). */
interface Stored { provider: BuilderProvider; baseUrl?: string; model?: string; keys?: Partial<Record<KeyProvider, string>>; key?: string; account?: { url: string; email?: string; token?: string } }

const PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai'];
const isProvider = (p: unknown): p is KeyProvider => p === 'anthropic' || p === 'openai';
const isBuilder = (p: unknown): p is BuilderProvider => isProvider(p) || p === 'account';
/** Where the Hull account server is when none was set: HULL_BACKEND_URL, else the backend run locally (backend/README.md). */
export const defaultAccountUrl = (env: NodeJS.ProcessEnv): string => (env['HULL_BACKEND_URL'] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
/** The encrypted keys, with an older file's single key moved under its provider. */
const cipherKeys = (s: Stored | null): Partial<Record<KeyProvider, string>> => {
  const out: Partial<Record<KeyProvider, string>> = { ...(s?.keys ?? {}) };
  if (s?.key && isProvider(s.provider) && !out[s.provider]) out[s.provider] = s.key;
  return out;
};

/** Env names that already give the Hull agent a model. */
export const KEY_ENV = ['ANTHROPIC_API_KEY', 'HULL_AGENT_API_KEY', 'HULL_AGENT_FAKE'] as const;
export const NEEDS_ACCOUNT = 'The builder needs you signed in to your Hull account. Sign in in Settings (Cmd+,) under Builder.';
export const NEEDS_KEY = 'The builder needs an API key. Add one in Settings (Cmd+,) under Builder: Anthropic, or any OpenAI-compatible endpoint.';

export interface SettingsStore {
  get(): Promise<AgentSettings>;
  set(input: AgentSettingsInput): Promise<AgentSettings>;
  /** The environment Hull's agent starts with: `base` with the saved settings laid over it. */
  env(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
  /** Null when the agent can run, else what is missing. */
  needs(base: NodeJS.ProcessEnv): Promise<string | null>;
  /** Keeps the account token after a sign-in (encrypted), and makes the account the provider. */
  setAccount(a: { url: string; email: string; token: string }): Promise<AgentSettings>;
  /** Forgets the account token; resolves with it (so the server can be told), or null. */
  clearAccount(): Promise<{ url: string; token: string } | null>;
  /** The account server's address (saved, or the default). */
  accountUrl(): Promise<string>;
}

/** The environment for the agent, from saved settings and the key. Pure, so it is tested without a disk. */
export function agentEnv(base: NodeJS.ProcessEnv, s: Stored | null, key: string | null): NodeJS.ProcessEnv {
  if (!s || !key) return { ...base };
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['HULL_AGENT_BASE_URL']; delete env['HULL_AGENT_API_KEY']; delete env['ANTHROPIC_API_KEY'];
  if (s.provider === 'account') {
    // The account server speaks Anthropic's API, so the builder talks to it as Anthropic with the account token.
    env['ANTHROPIC_API_KEY'] = key;
    env['ANTHROPIC_BASE_URL'] = s.account?.url ?? defaultAccountUrl(base);
  } else if (s.provider === 'anthropic') {
    env['ANTHROPIC_API_KEY'] = key;
    if (s.baseUrl) env['ANTHROPIC_BASE_URL'] = s.baseUrl;
  } else {
    env['HULL_AGENT_BASE_URL'] = s.baseUrl || 'https://api.openai.com/v1';
    env['HULL_AGENT_API_KEY'] = key;
  }
  if (s.model) env['HULL_AGENT_MODEL'] = s.model;
  return env;
}

const envSettings = (env: NodeJS.ProcessEnv): AgentSettings => ({
  provider: env['HULL_AGENT_BASE_URL'] ? 'openai' : 'anthropic',
  hasKey: KEY_ENV.some((k) => !!env[k]),
  ...(env['HULL_AGENT_BASE_URL'] ? { baseUrl: env['HULL_AGENT_BASE_URL'] } : {}),
  ...(env['HULL_AGENT_MODEL'] ? { model: env['HULL_AGENT_MODEL'] } : {}),
  source: 'environment',
});

export function createSettingsStore(o: { dataDir: string; crypto?: KeyCrypto | undefined; env?: NodeJS.ProcessEnv | undefined }): SettingsStore {
  const file = join(o.dataDir, 'agent-settings.json');
  const procEnv = (): NodeJS.ProcessEnv => o.env ?? process.env;
  // Electron's keychain answers asynchronously; asked once, on first use.
  let ready: Promise<KeyCrypto | null> | null = null;
  const cryptoOf = (): Promise<KeyCrypto | null> => (ready ??= (async () => (o.crypto && (await o.crypto.available()) ? o.crypto : null))());

  async function read(): Promise<Stored | null> {
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as Stored;
      return j && isBuilder(j.provider) ? j : null;
    } catch { return null; }
  }
  const keyFor = async (s: Stored | null, p: KeyProvider): Promise<string | null> => {
    const c = cipherKeys(s)[p];
    const crypto = await cryptoOf();
    if (!c || !crypto) return null;
    try { return (await crypto.decrypt(c)) || null; } catch { return null; }
  };
  const tokenOf = async (s: Stored | null): Promise<string | null> => {
    const c = s?.account?.token;
    const crypto = await cryptoOf();
    if (!c || !crypto) return null;
    try { return (await crypto.decrypt(c)) || null; } catch { return null; }
  };
  const keyOf = (s: Stored | null): Promise<string | null> => (!s ? Promise.resolve(null) : s.provider === 'account' ? tokenOf(s) : keyFor(s, s.provider));
  const save = async (next: Stored): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  };
  const accountView = async (s: Stored | null): Promise<{ url: string; email: string | null }> => ({
    url: s?.account?.url ?? defaultAccountUrl(procEnv()), email: (await tokenOf(s)) ? (s?.account?.email ?? '') : null,
  });

  return {
    async get() {
      if (!(await cryptoOf())) return envSettings(procEnv());
      const s = await read();
      const envHas = s?.provider !== 'account' && KEY_ENV.some((k) => !!procEnv()[k]);
      const keys = { anthropic: (await keyFor(s, 'anthropic')) !== null, openai: (await keyFor(s, 'openai')) !== null };
      return {
        provider: s?.provider ?? 'anthropic', hasKey: (await keyOf(s)) !== null || envHas, keys,
        ...(s?.baseUrl ? { baseUrl: s.baseUrl } : {}), ...(s?.model ? { model: s.model } : {}), source: 'app', account: await accountView(s),
      };
    },
    async set(input) {
      const crypto = await cryptoOf();
      if (!crypto) throw new Error(o.crypto ? 'This computer has no safe place to keep a key (no keychain). Set ANTHROPIC_API_KEY in the environment instead.' : 'In web mode the environment decides which key the builder uses: set ANTHROPIC_API_KEY (or HULL_AGENT_BASE_URL and HULL_AGENT_API_KEY) and restart.');
      if (!isBuilder(input.provider)) throw new Error('The provider must be anthropic, openai or account.');
      if (input.clearKey !== undefined && !isProvider(input.clearKey)) throw new Error('clearKey must be anthropic or openai.');
      if (input.keyFor !== undefined && !isProvider(input.keyFor)) throw new Error('keyFor must be anthropic or openai.');
      const prev = await read();
      const next: Stored = { provider: input.provider };
      // The account is kept across saves; a new address forgets the old sign-in, which belonged to the old server.
      const url = input.accountUrl?.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) throw new Error('The account server is an http(s) address, like http://127.0.0.1:8787.');
      if (url && url !== prev?.account?.url) next.account = { url };
      else if (prev?.account) next.account = prev.account;
      const baseUrl = input.baseUrl?.trim(); const model = input.model?.trim();
      if (baseUrl) next.baseUrl = baseUrl;
      if (model) next.model = model;
      // Each provider keeps its own key. An empty key field keeps the one already saved; a new one replaces it.
      const keys = cipherKeys(prev);
      const typed = input.apiKey?.trim();
      const target = input.keyFor ?? input.provider;
      if (typed && target === 'account') throw new Error('The Hull account signs in through the browser; it has no key to paste.');
      if (typed) keys[target as KeyProvider] = await crypto.encrypt(typed);
      if (input.clearKey) delete keys[input.clearKey];
      const kept = Object.fromEntries(PROVIDERS.filter((p) => keys[p]).map((p) => [p, keys[p]!])) as Partial<Record<KeyProvider, string>>;
      if (Object.keys(kept).length > 0) next.keys = kept;
      await save(next);
      return this.get();
    },
    async setAccount(a) {
      const crypto = await cryptoOf();
      if (!crypto) throw new Error('This computer has no safe place to keep the sign-in (no keychain).');
      const prev = await read();
      await save({ ...(prev ?? { provider: 'account' }), provider: 'account', account: { url: a.url, email: a.email, token: await crypto.encrypt(a.token) } });
      return this.get();
    },
    async clearAccount() {
      const prev = await read();
      const token = await tokenOf(prev);
      if (!prev?.account) return null;
      await save({ ...prev, account: { url: prev.account.url } });
      return token ? { url: prev.account.url, token } : null;
    },
    async accountUrl() { return (await read())?.account?.url ?? defaultAccountUrl(procEnv()); },
    async env(base) { const s = await read(); return agentEnv(base, s, await keyOf(s)); },
    async needs(base) {
      const s = await read();
      if (s?.provider === 'account') return (await tokenOf(s)) ? null : NEEDS_ACCOUNT;
      const e = await this.env(base);
      return KEY_ENV.some((k) => !!e[k]) ? null : NEEDS_KEY;
    },
  };
}
