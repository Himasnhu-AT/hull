// Which model the builder uses, and its key. In Electron the key is encrypted with safeStorage and kept in userData; the
// page only ever learns whether a key exists. In web mode there is no safe place to keep one, so the environment decides.
// The key is never logged and never part of anything returned to the renderer.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSettings, AgentSettingsInput } from '../shared/agentApi.ts';

/** Electron's safeStorage, reduced to what this needs (so tests can pass a stand-in). */
export interface KeyCrypto { available(): boolean; encrypt(plain: string): string; decrypt(cipher: string): string }

interface Stored { provider: 'anthropic' | 'openai'; baseUrl?: string; model?: string; key?: string }

/** Env names that already give the Hull agent a model. */
export const KEY_ENV = ['ANTHROPIC_API_KEY', 'HULL_AGENT_API_KEY', 'HULL_AGENT_FAKE'] as const;
export const NEEDS_KEY = 'The builder needs an API key. Add one in the key settings (Anthropic, or any OpenAI-compatible endpoint).';

export interface SettingsStore {
  get(): Promise<AgentSettings>;
  set(input: AgentSettingsInput): Promise<AgentSettings>;
  /** The environment Hull's agent starts with: `base` with the saved settings laid over it. */
  env(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
  /** Null when the agent can run, else what is missing. */
  needs(base: NodeJS.ProcessEnv): Promise<string | null>;
}

/** The environment for the agent, from saved settings and the key. Pure, so it is tested without a disk. */
export function agentEnv(base: NodeJS.ProcessEnv, s: Stored | null, key: string | null): NodeJS.ProcessEnv {
  if (!s || !key) return { ...base };
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['HULL_AGENT_BASE_URL']; delete env['HULL_AGENT_API_KEY']; delete env['ANTHROPIC_API_KEY'];
  if (s.provider === 'anthropic') {
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
  const crypto = o.crypto && o.crypto.available() ? o.crypto : null;

  async function read(): Promise<Stored | null> {
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as Stored;
      return j && (j.provider === 'anthropic' || j.provider === 'openai') ? j : null;
    } catch { return null; }
  }
  const keyOf = (s: Stored | null): string | null => {
    if (!s?.key || !crypto) return null;
    try { return crypto.decrypt(s.key) || null; } catch { return null; }
  };

  return {
    async get() {
      if (!crypto) return envSettings(procEnv());
      const s = await read();
      const envHas = KEY_ENV.some((k) => !!procEnv()[k]);
      return {
        provider: s?.provider ?? 'anthropic', hasKey: keyOf(s) !== null || envHas,
        ...(s?.baseUrl ? { baseUrl: s.baseUrl } : {}), ...(s?.model ? { model: s.model } : {}), source: 'app',
      };
    },
    async set(input) {
      if (!crypto) throw new Error(o.crypto ? 'This computer has no safe place to keep a key (no keychain). Set ANTHROPIC_API_KEY in the environment instead.' : 'In web mode the environment decides which key the builder uses: set ANTHROPIC_API_KEY (or HULL_AGENT_BASE_URL and HULL_AGENT_API_KEY) and restart.');
      if (input.provider !== 'anthropic' && input.provider !== 'openai') throw new Error('The provider must be anthropic or openai.');
      const prev = await read();
      const next: Stored = { provider: input.provider };
      const baseUrl = input.baseUrl?.trim(); const model = input.model?.trim();
      if (baseUrl) next.baseUrl = baseUrl;
      if (model) next.model = model;
      // An empty key field keeps the key already saved; a new one replaces it.
      const typed = input.apiKey?.trim();
      if (typed) next.key = crypto.encrypt(typed); else if (prev?.key) next.key = prev.key;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      return this.get();
    },
    async env(base) { const s = await read(); return agentEnv(base, s, keyOf(s)); },
    async needs(base) {
      const e = await this.env(base);
      return KEY_ENV.some((k) => !!e[k]) ? null : NEEDS_KEY;
    },
  };
}
