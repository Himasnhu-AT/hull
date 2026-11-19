// Who builds and on which model, as a chip inside the message box (like a chat app's model menu). It opens upward: Hull's
// builder with its model (Anthropic models picked here; anything else in Settings), the person's own Claude Code, or Codex.
// It works with or without a builder above it, so the home page shows it before a game exists.

import { useEffect, useRef, useState, type JSX } from 'react';
import type { AgentSettings, CliStatus } from '../../shared/agentApi.ts';
import { useSettings } from '../settings/open.tsx';
import { Icon } from '../ui/Icon.tsx';
import { readVia, writeVia, type BuilderVia } from './useBuilder.tsx';

/** The model Hull's agent uses when none is set (packages/agent/src/providers.ts). */
const DEFAULT_MODEL = 'claude-opus-5-5';
const ANTHROPIC_MODELS: { id: string; note: string }[] = [
  { id: 'claude-opus-5-5', note: 'Most capable' },
  { id: 'claude-sonnet-5-5', note: 'Fast and capable' },
  { id: 'claude-haiku-5-5', note: 'Fastest' },
];

/** "claude-opus-5-5" -> "Opus 5.5"; anything else as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m ? `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
}

export function ModelPicker(): JSX.Element {
  const settings = useSettings();
  const [via, setVia] = useState<BuilderVia>(readVia);
  const [cfg, setCfg] = useState<AgentSettings | null>(null);
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = (): void => {
    window.hullApp?.agentSettings().then(setCfg, () => {});
    window.hullApp?.cliStatus().then(setClis, () => setClis([]));
  };
  useEffect(() => { window.hullApp?.agentSettings().then(setCfg, () => {}); }, []);
  useEffect(() => { if (open) load(); }, [open]);
  useEffect(() => {
    const on = (e: Event): void => setVia((e as CustomEvent<BuilderVia>).detail);
    window.addEventListener('hull-builder-via', on);
    return () => window.removeEventListener('hull-builder-via', on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', out); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', out); window.removeEventListener('keydown', key, true); };
  }, [open]);

  const model = cfg?.model || (cfg?.provider === 'openai' ? 'endpoint default' : DEFAULT_MODEL);
  const label = via === 'claude' ? 'Claude Code' : via === 'codex' ? 'Codex' : modelName(model);
  const claude = clis?.find((c) => c.id === 'claude');
  const codex = clis?.find((c) => c.id === 'codex');

  const pickHull = async (m?: string): Promise<void> => {
    setOpen(false);
    if (!cfg?.hasKey) { settings.open('builder', load); return; }
    if (m && cfg.provider !== 'openai' && m !== (cfg.model || DEFAULT_MODEL)) setCfg(await window.hullApp!.setAgentSettings({ provider: cfg.provider, model: m, ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}) }));
    writeVia('hull');
  };

  return (
    <div className="mp" ref={box}>
      <button type="button" className={`mp-chip${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Who builds, and on which model">
        <Icon name={via === 'hull' ? 'chat' : 'terminal'} size={13} /><span>{label}</span><Icon name="chevron" size={10} />
      </button>
      {open && (
        <div className="mp-menu" role="menu">
          <div className="mp-h">{cfg?.provider === 'account' ? `Hull account${cfg.account?.email ? ` · ${cfg.account.email}` : ''}` : "Hull's builder"}{cfg && !cfg.hasKey && <span className="mp-need">{cfg.provider === 'account' ? 'sign in' : 'needs a key'}</span>}</div>
          {cfg?.provider !== 'openai' ? ANTHROPIC_MODELS.map((m) => (
            <button key={m.id} role="menuitemradio" aria-checked={via === 'hull' && model === m.id} onClick={() => void pickHull(m.id)}>
              <span><b>{modelName(m.id)}</b><small>{m.note}</small></span>{via === 'hull' && model === m.id && <Icon name="check" size={14} />}
            </button>
          )) : (
            <button role="menuitemradio" aria-checked={via === 'hull'} onClick={() => void pickHull()}>
              <span><b>{model}</b><small>{cfg.baseUrl ?? 'OpenAI-compatible'}</small></span>{via === 'hull' && <Icon name="check" size={14} />}
            </button>
          )}
          <hr />
          <div className="mp-h">Your own agents</div>
          <button role="menuitemradio" aria-checked={via === 'claude'} disabled={claude ? !claude.installed : false} onClick={() => { setOpen(false); writeVia('claude'); }}>
            <span><b>Claude Code</b><small>{!claude ? 'Looking...' : !claude.installed ? 'Not installed' : claude.signedIn ? `Signed in${claude.via ? ` with ${claude.via}` : ''}` : 'Not signed in'}</small></span>{via === 'claude' && <Icon name="check" size={14} />}
          </button>
          <button role="menuitemradio" aria-checked={via === 'codex'} disabled={codex ? !codex.installed : false} onClick={() => { setOpen(false); if (codex && !codex.signedIn) settings.open('codex', load); else writeVia('codex'); }}>
            <span><b>Codex</b><small>{!codex ? 'Looking...' : !codex.installed ? 'Not installed' : codex.signedIn ? `Signed in${codex.via ? ` with ${codex.via}` : ''}` : 'Sign in with ChatGPT'}</small></span>{via === 'codex' && <Icon name="check" size={14} />}
          </button>
          <hr />
          <button role="menuitem" onClick={() => { setOpen(false); settings.open('builder', load); }}><span><b>Model and keys...</b></span><Icon name="gear" size={13} /></button>
        </div>
      )}
    </div>
  );
}
