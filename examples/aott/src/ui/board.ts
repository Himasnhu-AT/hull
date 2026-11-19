// The leaderboard. Two tables:
//   * the squad, live: you and every comrade, ranked by score, with titans killed, limbs cut and people saved. A
//     small copy sits at the right edge of the screen all through a run; L opens the full one.
//   * your best runs, kept in this browser (localStorage): the ten highest scores with what each run came to.
// It owns its own DOM (inside the HUD root when there is one, so it scales and hides with it).
import * as keys from '../keys';
import type { Game, GameMode } from '../types';
import { epochMs } from '../realtime';

interface Row { name: string; you: boolean; kills: number; limbs: number; saved: number; score: number }
/** One finished run, as it is kept. */
export interface RunRecord { at: number; mode: string; wave: number; kills: number; limbs: number; saved: number; seconds: number; score: number }

const STORE = 'aott.runs.v1';
const KEEP = 10;
const MODE_NAME: Record<string, string> = { expedition: 'Holdout', gate: 'Seal the Breach', scout: 'The Twelfth Sortie' };
/** What a comrade's deeds are worth (yours are scored by the game flow: speed, combos and all). */
const WORTH = { kill: 300, limb: 100, saved: 400 };

const CSS = `
.aott-board{position:absolute;right:20px;top:50%;transform:translateY(-50%);min-width:168px;padding:8px 10px 9px;font:600 11px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6e1d6;
  background:rgba(14,16,18,.72);border:1px solid rgba(230,225,214,.14);border-radius:2px;pointer-events:none;font-variant-numeric:tabular-nums;transition:opacity .25s;opacity:0}
.aott-board.on{opacity:1}
.aott-root.cine .aott-board,.aott-root.hud-off .aott-board{opacity:0}
.aott-board h4{margin:0 0 5px;font-size:9.5px;font-weight:650;letter-spacing:.2em;text-transform:uppercase;color:#9a968c;display:flex;justify-content:space-between;gap:12px}
.aott-board h4 kbd{font:inherit;color:#e6e1d6;border:1px solid rgba(230,225,214,.28);padding:0 4px;border-radius:2px;letter-spacing:0}
.aott-board table{border-collapse:collapse;width:100%}
.aott-board td,.aott-board th{padding:1px 0 1px 10px;text-align:right;white-space:nowrap}
.aott-board td:first-child,.aott-board th:first-child{padding-left:0;text-align:left;color:#9a968c;width:14px}
.aott-board td:nth-child(2),.aott-board th:nth-child(2){text-align:left;padding-left:6px}
.aott-board th{font-size:9px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:#9a968c}
.aott-board tr.you td{color:#f0a43a}
.aott-board tr.you td:first-child{color:#f0a43a}
.aott-board-full{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,92vw);max-height:84vh;overflow:auto;padding:18px 22px 20px;font:600 13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:#e6e1d6;background:rgba(14,16,18,.93);border:1px solid rgba(230,225,214,.28);border-radius:2px;box-shadow:0 18px 60px rgba(0,0,0,.5);font-variant-numeric:tabular-nums;display:none;pointer-events:none;z-index:6}
.aott-board-full.on{display:block}
.aott-board-full h3{margin:0 0 2px;font-size:15px;letter-spacing:.24em;text-transform:uppercase}
.aott-board-full p{margin:0 0 12px;font-size:11px;font-weight:500;color:#9a968c}
.aott-board-full h4{margin:18px 0 6px;font-size:10px;font-weight:650;letter-spacing:.2em;text-transform:uppercase;color:#9a968c}
.aott-board-full table{border-collapse:collapse;width:100%}
.aott-board-full td,.aott-board-full th{padding:4px 0 4px 16px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(230,225,214,.08)}
.aott-board-full td:first-child,.aott-board-full th:first-child{padding-left:0;text-align:left;color:#9a968c;width:22px}
.aott-board-full td:nth-child(2),.aott-board-full th:nth-child(2){text-align:left}
.aott-board-full th{font-size:10px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:#9a968c}
.aott-board-full tr.you td{color:#f0a43a}
.aott-board-full tr.new td{color:#f0a43a}
.aott-board-full .none{color:#9a968c;font-weight:500;font-size:12px}
@media (max-width:900px){.aott-board{display:none}}`;

const fmtTime = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export class Board {
  readonly game: Game;
  rows: Row[] = [];
  runs: RunRecord[] = [];
  /** the full table is showing */
  open = false;
  private mode: GameMode = 'menu';
  private mini: HTMLElement; private full: HTMLElement;
  private drawn = ''; private drawT = 0;
  private live = false;
  private lastSaved = -1;

  constructor(game: Game) {
    this.game = game;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const host = document.querySelector('.aott-game') || document.body;
    this.mini = document.createElement('div'); this.mini.className = 'aott-board';
    this.full = document.createElement('div'); this.full.className = 'aott-board-full';
    host.appendChild(this.mini); (document.querySelector('.aott-root') || document.body).appendChild(this.full);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '[]') as unknown;
      if (Array.isArray(saved)) this.runs = (saved as RunRecord[]).filter((r) => r && typeof r.score === 'number').slice(0, KEEP);
    } catch { /* storage blocked: no records kept */ }
    const ev = game.events;
    // who did what
    ev.on('titan:killed', (e: { by?: { name: string } | null; titan?: { kind?: string } }) => { const r = this._row(e.by?.name); if (r) r.kills++; });
    ev.on('civilian:saved', (e: { by?: { name: string } | null }) => { const r = this._row(e.by?.name); if (r) r.saved++; });
    ev.on('squad:limb', (e: { by?: { name: string } }) => { const r = this._row(e.by?.name); if (r) r.limbs++; });
    ev.on('player:hit', (e: { result?: { effect?: string } | null }) => { if (e.result?.effect === 'cripple' || e.result?.effect === 'sever') { const r = this._row(); if (r) r.limbs++; } });
    ev.on('player:died', () => this.end());
  }

  private _row(name?: string | null): Row | null {
    if (!this.live) return null;
    const you = !name;
    let r = this.rows.find((x) => (you ? x.you : !x.you && x.name === name));
    if (!r) this.rows.push(r = { name: name || 'You', you, kills: 0, limbs: 0, saved: 0, score: 0 });
    return r;
  }

  /** A run starts: everyone back to nothing. */
  begin(mode: GameMode): void {
    this.end();
    this.mode = mode;
    this.live = mode === 'expedition' || mode === 'gate' || mode === 'scout';
    this.rows = [];
    this.lastSaved = -1;
    if (!this.live) { this.mini.classList.remove('on'); this.show(false); return; }
    this.rows.push({ name: 'You', you: true, kills: 0, limbs: 0, saved: 0, score: 0 });
    for (const a of this.game.allies || []) if (a.alive) this.rows.push({ name: a.name, you: false, kills: 0, limbs: 0, saved: 0, score: 0 });
    this.drawn = '';
  }

  /** The run is over (death, back to the title, a new start): keep it if it earned a place. */
  end(): void {
    if (!this.live) return;
    this.live = false;
    const me = this.rows.find((r) => r.you);
    const score = Math.round(this.game.flow?.score || 0);
    if (!me || score <= 0) return;
    const rec: RunRecord = {
      at: epochMs(), mode: this.mode, wave: this.game.flow.wave || 0, kills: me.kills, limbs: me.limbs, saved: me.saved,
      seconds: Math.round((this.game.time || 0) - (this.game.flow.startTime || 0)), score,
    };
    this.runs.push(rec);
    this.runs.sort((a, b) => b.score - a.score);
    this.runs.length = Math.min(this.runs.length, KEEP);
    this.lastSaved = this.runs.indexOf(rec);
    try { localStorage.setItem(STORE, JSON.stringify(this.runs)); } catch { /* not kept */ }
    this.drawn = '';
  }

  toggle(): void { this.show(!this.open); }
  show(on: boolean): void {
    this.open = on;
    this.full.classList.toggle('on', on);
    this.drawn = '';
    if (on) this._draw();
  }

  /** Once a frame (cheap: the tables are only rebuilt a few times a second, and only when something changed). */
  update(dt: number): void {
    const playing = this.game.mode !== 'menu';
    this.mini.classList.toggle('on', this.live && playing && !this.open);
    if (!this.live && !this.open) return;
    if ((this.drawT -= dt) > 0) return;
    this.drawT = 0.4;
    this._draw();
  }

  private _ranked(): Row[] {
    for (const r of this.rows) r.score = r.you ? Math.round(this.game.flow?.score || 0) : r.kills * WORTH.kill + r.limbs * WORTH.limb + r.saved * WORTH.saved;
    return this.rows.slice().sort((a, b) => b.score - a.score || Number(b.you) - Number(a.you));
  }

  private _draw(): void {
    const rows = this._ranked();
    const key = rows.map((r) => `${r.name}:${r.kills}:${r.limbs}:${r.saved}:${r.score}`).join('|') + (this.open ? '#open' + this.runs.length + this.lastSaved : '');
    if (key === this.drawn) return;
    this.drawn = key;
    // the small one: the top four, and you if you are not among them
    let top = rows.slice(0, 4);
    const me = rows.findIndex((r) => r.you);
    if (me >= 4) top = [...rows.slice(0, 3), rows[me]];
    this.mini.innerHTML = `<h4><span>Squad</span><span><kbd>${esc(keys.label('board'))}</kbd></span></h4><table><tr><th></th><th></th><th>Kills</th><th>Saved</th></tr>`
      + top.map((r) => `<tr class="${r.you ? 'you' : ''}"><td>${rows.indexOf(r) + 1}</td><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.saved}</td></tr>`).join('') + '</table>';
    if (!this.open) return;
    const squad = rows.length
      ? '<table><tr><th>#</th><th>Soldier</th><th>Titans</th><th>Limbs</th><th>Saved</th><th>Score</th></tr>'
        + rows.map((r, i) => `<tr class="${r.you ? 'you' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.kills}</td><td>${r.limbs}</td><td>${r.saved}</td><td>${r.score.toLocaleString('en-US')}</td></tr>`).join('') + '</table>'
      : '<div class="none">Start Holdout or a mission: the squad is ranked as the run goes.</div>';
    const best = this.runs.length
      ? '<table><tr><th>#</th><th>Run</th><th>Wave</th><th>Titans</th><th>Limbs</th><th>Saved</th><th>Time</th><th>Score</th></tr>'
        + this.runs.map((r, i) => `<tr class="${i === this.lastSaved ? 'new' : ''}"><td>${i + 1}</td><td>${esc(MODE_NAME[r.mode] || r.mode)} · ${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td><td>${r.wave || '—'}</td><td>${r.kills}</td><td>${r.limbs}</td><td>${r.saved}</td><td>${fmtTime(r.seconds)}</td><td>${r.score.toLocaleString('en-US')}</td></tr>`).join('') + '</table>'
      : '<div class="none">No finished runs yet. Your ten best are kept here, in this browser.</div>';
    this.full.innerHTML = `<h3>Leaderboard</h3><p>${esc(keys.label('board'))} closes this. Comrades score ${WORTH.kill} a titan, ${WORTH.limb} a limb, ${WORTH.saved} a person carried to safety.</p>`
      + `<h4>This run: the squad</h4>${squad}<h4>Your best runs</h4>${best}`;
  }
}
