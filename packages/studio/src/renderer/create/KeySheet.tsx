// The builder's key settings: which model it uses and the key. The key goes to the app's main process and is never shown again;
// the sheet only learns whether one is saved. In web mode the environment decides, and the sheet says so.

import { useEffect, useRef, useState, type JSX } from 'react';
import type { AgentSettings } from '../../shared/agentApi.ts';

export interface KeySheetProps { onClose(): void; onSaved(): void }

export function KeySheet({ onClose, onSaved }: KeySheetProps): JSX.Element {
  const [cur, setCur] = useState<AgentSettings | null>(null);
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    let live = true;
    window.hullApp?.agentSettings().then((s) => {
      if (!live) return;
      setCur(s); setProvider(s.provider); setBaseUrl(s.baseUrl ?? ''); setModel(s.model ?? '');
    }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => { first.current?.focus(); }, [cur]);
  useEffect(() => {
    const k = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await window.hullApp!.setAgentSettings({ provider, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) });
      setKey('');
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const env = cur?.source === 'environment';
  const canSave = !busy && (key.trim() !== '' || cur?.hasKey === true);

  return (
    <div className="cr-sheet-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cr-sheet cr-keysheet" role="dialog" aria-modal="true" aria-label="Builder key settings">
        <div className="cr-sheet-head"><b>The builder's key</b><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Close</button></div>
        <div className="cr-keybody">
          {cur === null && !error && <div className="skeleton" />}
          {env && (
            <>
              <p className="cr-sub">In this window the environment decides which key the builder uses. Set <code>ANTHROPIC_API_KEY</code> (or <code>HULL_AGENT_BASE_URL</code> and <code>HULL_AGENT_API_KEY</code> for any OpenAI-compatible service) before starting Hull, then restart it.</p>
              <p className="cr-sub">{cur!.hasKey ? 'A key is set in the environment.' : 'No key is set in the environment.'}</p>
            </>
          )}
          {cur !== null && !env && (
            <form className="cr-keyform" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
              <label>Service
                <select ref={first} value={provider} onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai')}>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI-compatible (any endpoint)</option>
                </select>
              </label>
              <label>API key
                <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={cur.hasKey ? 'A key is saved. Leave empty to keep it.' : 'Paste your key'} />
              </label>
              {provider === 'openai' && (
                <label>Endpoint
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
                </label>
              )}
              <label>Model <span className="cr-k">(optional)</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === 'anthropic' ? 'The default Claude model' : 'The default model of the endpoint'} spellCheck={false} />
              </label>
              <p className="cr-sub">The key is kept encrypted by your computer's keychain and handed to the builder when it starts. Hull never shows it again and never writes it to a log.</p>
              <div className="cr-row"><button className="btn primary lg" type="submit" disabled={!canSave}>{busy ? 'Saving...' : 'Save'}</button></div>
            </form>
          )}
          {error && <div className="note-err" role="alert">{error}</div>}
        </div>
      </div>
    </div>
  );
}
