// AOTT HUD: a DOM overlay above the WebGL canvas. "Iron and bone": graphite panels in the corners, the centre left to
// the reticle and the world markers. Owns its CSS (hud-style.ts, injected once as a
// <style> element); no three.js dependency.
// update(s) runs every frame: it only writes to the DOM when a displayed value actually changed.
// Keycaps carry data-k="<action>" (keys.ts) and show the player's current binding; the KEYS screen rebinds them.
import * as keys from '../keys';
import { TITLE, TAGLINE, MISSION, MOVE } from '../brand';
import type { Game, GameMode, HudState, NapeMarker, HookTargetMarker, ThreatMarker, Hint } from '../types';
import { HUD_CSS } from './hud-style';
import { emblemSVG } from './emblem';
import { trackRestart } from '../analytics';
import { later, wallMs } from '../realtime';

// ------------------------------------------------------------------------------------------------ public shapes

/** The per-frame HUD state (built in main.ts) and its markers are shared types; re-exported here for convenience. */
export type { HudState } from '../types';

/** A mission and its chapters, as missionList() in src/missions/index.ts builds them. */
export interface HudMission {
  id: string;
  title: string;
  place?: string;
  eps?: string;
  chapters: readonly { title: string; eps?: string; desc?: string; locked?: boolean }[];
}

/** A mode or mission id the title screen can start. */
export type PlayMode = Exclude<GameMode, 'menu'>;
export type StartFn = (mode: PlayMode, opts?: { chapter?: number }) => void;

/** End-of-run screen. `cause` is the headline; `win` turns it into a victory screen. */
export interface DeathStats {
  cause?: string;
  kills?: number;
  score?: number;
  /** seconds */
  time?: number;
  win?: boolean;
  retryLabel?: string | null;
  wave?: number;
  topSpeed?: number;
}

/** Training Yard results: times in seconds, avgSpeed in km/h. */
export interface TrainingResult {
  time?: number | null;
  best?: number | null;
  cuts?: number;
  total?: number;
  avgSpeed?: number;
  newBest?: boolean;
}

/** message() styles: a toast ('info', 'warn') or a big cinematic line ('big'). */
export type MessageStyle = 'info' | 'warn' | 'big';
/** feed() kinds: squad radio, kills, trouble. */
export type FeedKind = 'info' | 'radio' | 'kill' | 'warn';

// ------------------------------------------------------------------------------------------------ markup

const MODE_LABEL: Record<string, string> = {
  expedition: MISSION.waves, gate: MISSION.gate, scout: MISSION.sortie, training: MISSION.training, free: MISSION.free,
};

const ROW_ARROW = '<u aria-hidden="true">&rsaquo;</u>';
const row = (attrs: string, n: string, title: string, desc: string, cls = '') =>
  `<button class="aott-row${cls}" ${attrs}><i>${n}</i><span><b>${title}</b><small>${desc}</small></span>${ROW_ARROW}</button>`;

const CONTROLS_CARD = `<div class="aott-side aott-panel aott-ctl-card">
  <div class="aott-card-h"><span class="aott-label">Controls</span><span class="aott-label">Keyboard</span></div>
  <div data-keys></div></div>`;

const TEMPLATE = `
<div class="aott-game">
  <div class="aott-hit"></div>
  <div class="aott-vig"></div>
  <div class="aott-napes"></div>
  <div class="aott-threats"></div>
  <div class="aott-tgts">
    <div class="aott-tgt" data-side="0" data-att="0"><svg viewBox="0 0 9 24" aria-hidden="true"><path d="M8 1 H1 V23 H8"/></svg><i></i><kbd data-k="ropeL"></kbd></div>
    <div class="aott-tgt" data-side="1" data-att="0"><svg viewBox="0 0 9 24" aria-hidden="true"><path d="M1 1 H8 V23 H1"/></svg><i></i><kbd data-k="ropeR"></kbd></div>
  </div>

  <div class="aott-tl aott-panel">${emblemSVG()}<div class="aott-mode"><b></b><span></span></div></div>
  <div class="aott-obj aott-panel"><span></span></div>
  <div class="aott-toast info"></div>
  <div class="aott-tr aott-panel">
    <div class="aott-tr-row" data-r="timer" hidden><span class="aott-label">Time</span><b>00:00.0</b></div>
    <div class="aott-tr-row" data-r="targets" hidden><span class="aott-label">Dummies left</span><b class="sm">0 / 0</b></div>
  </div>
  <div class="aott-feed"></div>

  <div class="aott-blc">
    <div class="aott-cc aott-panel">
      <span class="k"><kbd data-k="forward"></kbd><kbd data-k="strafeL"></kbd><kbd data-k="back"></kbd><kbd data-k="strafeR"></kbd></span><span class="t"><b>move</b> &middot; on a rope: pump / swing / slacken</span>
      <span class="k"><kbd data-k="left"></kbd><kbd data-k="right"></kbd></span><span class="t"><b>turn</b> (or the mouse)</span>
      <span class="k"><kbd data-k="jump"></kbd></span><span class="t"><b>jump</b> &middot; in the air: <b>cut</b></span>
      <span class="k"><kbd data-k="ropeL"></kbd><kbd data-k="ropeR"></kbd></span><span class="t"><b>hold</b>: rope left / right &middot; both = zip</span>
      <span class="k"><kbd data-k="land"></kbd></span><span class="t"><b>land</b> on what your rope is in</span>
      <span class="k"><kbd data-k="hang"></kbd></span><span class="t"><b>hang</b>: lock the lines &middot; then winch / swing</span>
      <span class="k"><kbd data-k="forward"></kbd></span><span class="t">at a wall: <b>run along</b> it &middot; square on: <b>climb</b></span>
      <span class="k"><kbd data-k="gas"></kbd></span><span class="t"><b>gas</b> boost</span>
      <span class="k"><kbd data-k="cut"></kbd></span><span class="t"><b>cut</b> anywhere &middot; hold flying fast = ${MOVE.spin}</span>
      <span class="k"><kbd data-k="card"></kbd></span><span class="t">hide this card</span>
    </div>
    <div class="aott-status aott-panel" data-low="0">
      <span class="aott-label">HP</span>
      <div class="aott-track aott-hp"><div class="aott-fill"></div></div>
      <span class="v hp" data-v="hp">100</span>
      <span class="aott-label">Gas</span>
      <div class="aott-track aott-gas" data-lv="ok"><div class="aott-fill"></div></div>
      <span class="v"><span data-v="gas">100</span><small>%</small></span>
      <span class="aott-label">Blades</span>
      <div class="aott-blades"><div class="aott-blade"><div class="aott-fill"></div></div><div class="aott-blade"><div class="aott-fill"></div></div></div>
      <span class="v"><small>&times;</small><span data-v="spare">0</span></span>
    </div>
  </div>

  <div class="aott-ret" data-valid="1" data-lock="0">
    <div class="aott-ticks"><i></i><i></i><i></i><i></i></div>
    <div class="aott-dot"></div>
    <svg class="aott-lock" viewBox="-22 -22 44 44" aria-hidden="true">
      <path d="M-20 -12 V-20 H-12 M20 -12 V-20 H12 M-20 12 V20 H-12 M20 12 V20 H12" fill="none" stroke="#c4372b" stroke-width="2" stroke-linecap="square"/>
    </svg>
    <div class="aott-dist"></div>
    <div class="aott-hk" data-side="0" data-state="idle"><svg viewBox="0 0 10 18" aria-hidden="true"><path d="M9 1 H2 V17 H9"/></svg><span data-k="ropeL"></span></div>
    <div class="aott-hk" data-side="1" data-state="idle"><svg viewBox="0 0 10 18" aria-hidden="true"><path d="M1 1 H8 V17 H1"/></svg><span data-k="ropeR"></span></div>
  </div>
  <div class="aott-hint aott-panel"><span class="ks"></span><span class="tx"></span></div>
  <div class="aott-grab">
    <div class="aott-grab-t"><span>MASH</span><kbd data-k="cut" data-up></kbd></div>
    <div class="aott-track aott-grab-bar"><div class="aott-fill"></div></div>
    <div class="aott-label">Cut yourself free</div>
  </div>

  <div class="aott-br aott-panel">
    <div class="aott-combo"></div>
    <div class="aott-speed-row"><span class="aott-speed">0</span><span class="aott-label">km/h</span></div>
    <div class="aott-track aott-speed-bar"><div class="aott-fill"></div></div>
    <div class="aott-stats">
      <div><span class="aott-label">Kills</span><b data-v="kills">0</b></div>
      <div><span class="aott-label">Score</span><b data-v="score">0</b></div>
    </div>
  </div>

  <div class="aott-dmgs"></div>
  <div class="aott-big"><span></span><i></i></div>
  <div class="aott-sub"><b></b><span></span></div>
  <div class="aott-fade"></div>
</div>

<div class="aott-screen aott-menu">
  <div class="aott-split">
    <div class="aott-main">
      <div class="aott-brand">${emblemSVG()}<h1 class="aott-word">${TITLE}</h1><div class="aott-tag">${TAGLINE}</div></div>
      <nav class="aott-rows">
        ${row('data-mode="expedition"', '01', MISSION.waves, 'Hold the wall against endless waves')}
        ${row('data-act="missions"', '02', 'Missions', 'The campaign, chapter by chapter')}
        ${row('data-mode="training"', '03', MISSION.training, 'Cut every dummy against the clock')}
        ${row('data-mode="free"', '04', MISSION.free, 'No titans, endless gas')}
        ${row('', '&mdash;', 'Keys', 'Change the controls', ' sub aott-keys-btn')}
      </nav>
      <div class="aott-foot">&uarr; &darr; select &middot; Enter confirm</div>
    </div>
    ${CONTROLS_CARD}
  </div>
</div>

<div class="aott-screen aott-pause">
  <div class="aott-split">
    <div class="aott-main">
      <div class="aott-kicker aott-pause-k"></div>
      <h2 class="aott-h" style="margin-top:10px">Paused</h2>
      <nav class="aott-rows">
        ${row('', '01', 'Resume', 'Back to it', ' aott-resume')}
        ${row('', '02', 'Restart', 'Start this run over', ' aott-restart')}
        ${row('', '03', 'Keys', 'Change the controls', ' sub aott-keys-btn')}
        ${row('', '04', 'Quit to title', 'Leave this run', ' sub aott-quit')}
      </nav>
    </div>
    ${CONTROLS_CARD}
  </div>
</div>

<div class="aott-screen aott-keys aott-dim">
  <div class="aott-center">
    <div class="aott-card aott-keys-card">
      <div class="aott-card-h"><h2 class="aott-h aott-h-sm">Keys</h2><span class="aott-label">Two keys per action</span></div>
      <p class="aott-note aott-keys-note">Click a key, then press the new key. <b>Esc</b> cancels, <b>Backspace</b> clears. A key moves from its old action.</p>
      <div class="aott-kb"></div>
      <div class="aott-btns">
        <button class="aott-btn primary" data-act="keys-back">Back</button>
        <button class="aott-btn" data-act="keys-reset">Defaults</button>
      </div>
    </div>
  </div>
</div>

<div class="aott-screen aott-result aott-dim">
  <div class="aott-center">
    <div class="aott-card aott-end aott-result-card">
      <div class="aott-kicker">${MISSION.training}</div>
      <h1 class="aott-cause aott-result-h">Course cleared</h1>
      <div class="aott-badge">New record</div>
      <div class="aott-time">00:00.0</div>
      <div class="aott-cells">
        <div><span class="aott-label">Best</span><b data-r="best">--:--.-</b></div>
        <div><span class="aott-label">Dummies</span><b data-r="cuts">0 / 0</b></div>
        <div><span class="aott-label">Avg cut</span><b data-r="avg"><span>0</span><small>KM/H</small></b></div>
      </div>
      <div class="aott-btns">
        <button class="aott-btn primary" data-act="again">Run again</button>
        <button class="aott-btn" data-act="menu">Menu</button>
      </div>
    </div>
  </div>
</div>

<div class="aott-screen aott-missions aott-dim">
  <div class="aott-center">
    <div class="aott-card aott-missions-card">
      <div class="aott-card-h"><h2 class="aott-h aott-h-sm">Missions</h2><span class="aott-label">In story order</span></div>
      <p class="aott-note aott-keys-note">Finish a chapter to open the next one.</p>
      <div class="aott-mlist"></div>
      <div class="aott-btns"><button class="aott-btn" data-act="missions-back">Back</button></div>
    </div>
  </div>
</div>

<div class="aott-screen aott-death">
  <div class="aott-center">
    <div class="aott-card aott-end">
      <div class="aott-kicker aott-death-k">Mission failed</div>
      <h1 class="aott-cause aott-death-title">You were eaten</h1>
      <div class="aott-cells">
        <div><span class="aott-label">Kills</span><b data-d="kills">0</b></div>
        <div><span class="aott-label">Score</span><b data-d="score">0</b></div>
        <div><span class="aott-label">Time</span><b data-d="time">0:00</b></div>
      </div>
      <div class="aott-btns">
        <button class="aott-btn primary aott-death-next" hidden>Next chapter</button>
        <button class="aott-btn primary aott-retry">Return to the wall</button>
        <button class="aott-btn aott-death-menu" hidden>Menu</button>
      </div>
    </div>
  </div>
</div>
`;

// Control reference shared by the title screen and the pause screen: four groups, read left to right.
const CONTROL_ROWS = `
<div class="aott-ctl">
  <div class="aott-grp">
    <div class="aott-grp-h">MOVE</div>
    <div class="aott-grp-k aott-arrows"><kbd data-k="forward"></kbd><kbd data-k="strafeL"></kbd><kbd data-k="back"></kbd><kbd data-k="strafeR"></kbd></div>
    <ul><li><b data-k="forward"></b> <b data-k="strafeL"></b> <b data-k="back"></b> <b data-k="strafeR"></b> move &middot; swing on a rope</li><li><b data-k="left"></b> <b data-k="right"></b> or the mouse: turn</li><li><b data-k="jump"></b> jump</li></ul>
  </div>
  <div class="aott-grp">
    <div class="aott-grp-h">ROPES</div>
    <div class="aott-grp-k"><kbd data-k="ropeL"></kbd><kbd data-k="ropeR"></kbd></div>
    <ul><li>hold <b data-k="ropeL"></b> left &middot; <b data-k="ropeR"></b> right</li><li>sticks at the marker</li><li><b data-k="ropeL"></b> + <b data-k="ropeR"></b> zip forward</li><li><b data-k="land"></b>: land on the branch / roof it's in</li></ul>
  </div>
  <div class="aott-grp">
    <div class="aott-grp-h">GAS</div>
    <div class="aott-grp-k"><kbd data-k="gas"></kbd></div>
    <ul><li><b>boost</b> &middot; reel faster</li><li>kicks you off a trunk</li></ul>
  </div>
  <div class="aott-grp">
    <div class="aott-grp-h">CUT</div>
    <div class="aott-grp-k"><kbd data-k="jump" data-big></kbd></div>
    <ul><li>in the air: <b>slash</b> the nape</li><li>hold flying fast: <b>${MOVE.spin}</b></li><li><b data-k="cut"></b> or click: cut anywhere</li></ul>
  </div>
</div>
<div class="aott-ctl-more">
  <span><kbd>Esc</kbd><kbd data-k="pause"></kbd> pause</span><span><kbd data-k="whistle"></kbd> whistle for horse</span><span><kbd data-k="flare"></kbd> signal flare</span><span><kbd data-k="mute"></kbd> mute</span><span><kbd data-k="card"></kbd> controls card</span>
  <span><kbd data-k="blades"></kbd> blades (auto when dull)</span><span><kbd data-k="left"></kbd><kbd data-k="right"></kbd> turn</span><span><kbd data-k="jump"></kbd> jump &middot; cut in the air</span><span><kbd data-k="cut"></kbd> cut</span>
</div>
<p class="aott-note"><b>Mouse optional:</b> click the game to look with the mouse</p>`;

// Key names for hint keycaps: accepts 'Z', 'Left', 'ArrowLeft', 'Space', 'Shift', ...
const KEY_LABEL: Record<string, string> = {
  left: '←', arrowleft: '←', right: '→', arrowright: '→', up: '↑', arrowup: '↑',
  down: '↓', arrowdown: '↓', space: 'Space', ' ': 'Space', shift: 'Shift', shiftleft: 'Shift',
  escape: 'Esc', esc: 'Esc', enter: 'Enter',
};
const THREAT_SVG = '<svg viewBox="-10 -9 20 16" aria-hidden="true"><path d="M-9 6 L0 -7 L9 6 L0 1.5 Z"/></svg>';
/** Speed (km/h) that fills the speed bar. */
const SPEED_BAR_MAX = 250;

// ------------------------------------------------------------------------------------------------ helpers

let _cssInjected = false;
function injectStyles(): void {
  if (_cssInjected) return;
  _cssInjected = true;
  try {
    const style = document.createElement('style');
    style.id = 'aott-hud-style';
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
  } catch { /* no document head: nothing to style */ }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Number to a 0..1 fraction, quantised to 1/500 so tiny drifts do not touch the DOM. */
function frac(v: unknown, fallback: number): number {
  const x = Number(v);
  if (!Number.isFinite(x)) return fallback;
  return Math.round(clamp(x, 0, 1) * 500) / 500;
}
function fmtTime(t: unknown): string {
  const n = Number(t);
  if (!Number.isFinite(n)) return typeof t === 'string' ? t : '--:--';
  const m = Math.floor(n / 60), s = Math.floor(n % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
/** Seconds as tenths (integer), or -1 when not a number. */
function tenths(t: unknown): number {
  const n = Number(t);
  return t === null || t === undefined || !Number.isFinite(n) ? -1 : Math.floor(Math.max(0, n) * 10 + 1e-6);
}
/** Tenths of a second to mm:ss.t (e.g. 1234 -> "02:03.4"); -1 -> "--:--.-". */
function fmtClock(tt: number): string {
  if (!(tt >= 0)) return '--:--.-';
  const m = Math.floor(tt / 600), s = Math.floor(tt / 10) % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (tt % 10);
}
const count = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));
function hintKeyLabel(k: string): string {
  const s = String(k);
  return KEY_LABEL[s.toLowerCase()] || (s.length === 1 ? s.toUpperCase() : s);
}
/** Keycap for a hint: an action id (shows its bound key) or a literal key name. */
function kbdFor(k: string): HTMLElement {
  const n = document.createElement('kbd');
  if (keys.ACTIONS.some((a) => a.id === k)) { n.setAttribute('data-k', k); paintKey(n); return n; }
  const label = hintKeyLabel(k);
  n.textContent = label;
  if (label.length > 2) n.className = 'w';
  return n;
}
/** Write the current binding into a data-k element (data-s = slot, data-up = upper case, data-big = wide cap). */
function paintKey(n: HTMLElement): void {
  const id = n.getAttribute('data-k') || '', slot = +(n.getAttribute('data-s') || 0);
  const k: string | null = slot ? keys.slotKey(id, slot) : keys.keysFor(id)[0];
  let t: string = slot ? keys.keyLabel(k) : keys.label(id);
  if (n.hasAttribute('data-up')) t = t.toUpperCase();
  n.textContent = t;
  if (n.tagName === 'KBD') {
    n.style.display = t ? '' : 'none';
    const sp = n.hasAttribute('data-big') && t === 'Space';
    n.classList.toggle('sp', sp);
    n.classList.toggle('w', !sp && t.length > 2);
    if (id === 'ropeL') n.classList.add('z');
    if (id === 'ropeR') n.classList.add('x');
  }
}
function must<T extends Element>(root: ParentNode, sel: string): T {
  const n = root.querySelector<T>(sel);
  if (!n) throw new Error('hud: missing ' + sel);
  return n;
}

// ------------------------------------------------------------------------------------------------ the HUD

interface NapeNode { node: HTMLDivElement; label: HTMLElement; x: number; y: number; d: number; on: boolean }
interface ThreatNode { node: HTMLDivElement; x: number; y: number; a: number; danger: boolean; on: boolean }
interface TargetNode { node: HTMLElement; x: number; y: number; on: boolean | null; att: boolean | null }
interface DmgBox { d: HTMLElement; x: number; y: number; w: number; h: number; t: number }

/** Last written values, so update() can skip unchanged ones. NaN / null mean "not written yet". */
interface Cache {
  hp: number; hpPct: number; gas: number; gasPct: number; gasLv: string; blade: number; bladeLow: boolean | null; swap: boolean | null;
  spare: number; kmh: number; kills: number; score: number; combo: number; obj: string; mode: string;
  hooks: string[]; aim: number; dist: number; timer: number; targets: string | null; trOn: boolean | null; cc: boolean | null;
  cine: boolean | null; grabbed: boolean | null; struggle: number; hint: string | null;
}

interface HudEls {
  status: HTMLElement; hpFill: HTMLElement; hpVal: HTMLElement; hit: HTMLElement;
  gas: HTMLElement; gasFill: HTMLElement; gasVal: HTMLElement;
  blades: HTMLElement; bladeFill: HTMLElement[]; spare: HTMLElement;
  modeName: HTMLElement; modeSub: HTMLElement;
  ret: HTMLElement; dist: HTMLElement; hooks: HTMLElement[];
  napeLayer: HTMLElement; threatLayer: HTMLElement; tgts: HTMLElement[];
  speed: HTMLElement; speedFill: HTMLElement; combo: HTMLElement; kills: HTMLElement; score: HTMLElement;
  obj: HTMLElement; objText: HTMLElement; toast: HTMLElement; feed: HTMLElement;
  big: HTMLElement; bigText: HTMLElement; sub: HTMLElement; subWho: HTMLElement; subText: HTMLElement; fade: HTMLElement;
  dmgs: HTMLElement;
  tr: HTMLElement; timerRow: HTMLElement; timer: HTMLElement; targetsRow: HTMLElement; targets: HTMLElement;
  cc: HTMLElement; hint: HTMLElement; hintKeys: HTMLElement; hintText: HTMLElement; grabFill: HTMLElement;
  menu: HTMLElement; pause: HTMLElement; pauseKick: HTMLElement;
  death: HTMLElement; deathKick: HTMLElement; deathTitle: HTMLElement; deathKills: HTMLElement; deathScore: HTMLElement;
  deathTime: HTMLElement; deathRetry: HTMLButtonElement; deathMenu: HTMLButtonElement; deathNext: HTMLButtonElement;
  missions: HTMLElement; mlist: HTMLElement;
  result: HTMLElement; resultCard: HTMLElement; resultTitle: HTMLElement; resultTime: HTMLElement;
  resultBest: HTMLElement; resultCuts: HTMLElement; resultAvg: HTMLElement;
  keys: HTMLElement; kb: HTMLElement;
}

export class Hud {
  readonly game: Game;
  readonly root: HTMLDivElement;
  readonly el: HudEls;

  private _c: Cache = {
    hp: NaN, hpPct: NaN, gas: NaN, gasPct: NaN, gasLv: '', blade: NaN, bladeLow: null, swap: null,
    spare: NaN, kmh: NaN, kills: NaN, score: NaN, combo: NaN, obj: '\0', mode: '\0',
    hooks: ['', ''], aim: NaN, dist: NaN, timer: NaN, targets: null, trOn: null, cc: null,
    cine: null, grabbed: null, struggle: NaN, hint: null,
  };
  private _t: { toast: number; big: number; hint: number } = { toast: 0, big: 0, hint: 0 };
  private _subT = 0;
  private _bigRaf = 0;
  private _toastRaf = 0;
  private _napes: NapeNode[] = [];
  private _threats: ThreatNode[] = [];
  private _tgts: TargetNode[];
  private _dmgLive: DmgBox[] = [];
  private _onStart: StartFn | null = null;
  private _onResume: (() => void) | null = null;
  private _onRetry: (() => void) | null = null;
  private _onMenu: (() => void) | null = null;          // death screen MENU
  private _onNext: (() => void) | null = null;          // death screen NEXT CHAPTER
  private _onAgain: (() => void) | null = null;         // training result RUN AGAIN
  private _onResultMenu: (() => void) | null = null;    // training result MENU
  private _missions: readonly HudMission[] = [];
  private _hintObj: Hint | null | undefined = undefined;
  private _hintTxt: string | undefined = undefined;
  private _hintNext: { keys: readonly string[]; text: string } | null = null;   // hint waiting for the previous one to fade
  private _keysFrom: HTMLElement | null = null;
  private _wait: HTMLButtonElement | null = null;       // KEYS slot waiting for a key
  private _sel = 0;                                     // highlighted button on the shown screen
  private _vw: number;
  private _vh: number;
  private _still: MediaQueryList | null = null;         // prefers-reduced-motion

  constructor(game: Game) {
    this.game = game;
    this._vw = typeof innerWidth === 'number' ? innerWidth : 1280;
    this._vh = typeof innerHeight === 'number' ? innerHeight : 720;
    try { this._still = matchMedia('(prefers-reduced-motion: reduce)'); } catch { /* no matchMedia */ }

    injectStyles();
    const root = document.createElement('div');
    root.className = 'aott-root';
    root.innerHTML = TEMPLATE;
    root.querySelectorAll('[data-keys]').forEach((n) => { n.innerHTML = CONTROL_ROWS; });
    document.body.appendChild(root);
    this.root = root;

    const q = <T extends HTMLElement = HTMLElement>(sel: string): T => must<T>(root, sel);
    const all = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));
    const sub = q('.aott-sub'), big = q('.aott-big');
    this.el = {
      status: q('.aott-status'), hpFill: q('.aott-hp .aott-fill'), hpVal: q('[data-v="hp"]'), hit: q('.aott-hit'),
      gas: q('.aott-gas'), gasFill: q('.aott-gas .aott-fill'), gasVal: q('[data-v="gas"]'),
      blades: q('.aott-blades'), bladeFill: all('.aott-blade .aott-fill'), spare: q('[data-v="spare"]'),
      modeName: q('.aott-mode b'), modeSub: q('.aott-mode span'),
      ret: q('.aott-ret'), dist: q('.aott-dist'), hooks: all('.aott-hk'),
      napeLayer: q('.aott-napes'), threatLayer: q('.aott-threats'), tgts: all('.aott-tgt'),
      speed: q('.aott-speed'), speedFill: q('.aott-speed-bar .aott-fill'), combo: q('.aott-combo'),
      kills: q('[data-v="kills"]'), score: q('[data-v="score"]'),
      obj: q('.aott-obj'), objText: q('.aott-obj span'), toast: q('.aott-toast'), feed: q('.aott-feed'),
      big, bigText: must<HTMLElement>(big, 'span'), sub, subWho: must<HTMLElement>(sub, 'b'), subText: must<HTMLElement>(sub, 'span'),
      fade: q('.aott-fade'), dmgs: q('.aott-dmgs'),
      tr: q('.aott-tr'), timerRow: q('[data-r="timer"]'), timer: q('[data-r="timer"] b'),
      targetsRow: q('[data-r="targets"]'), targets: q('[data-r="targets"] b'),
      cc: q('.aott-cc'), hint: q('.aott-hint'), hintKeys: q('.aott-hint .ks'), hintText: q('.aott-hint .tx'),
      grabFill: q('.aott-grab-bar .aott-fill'),
      menu: q('.aott-menu'), pause: q('.aott-pause'), pauseKick: q('.aott-pause-k'),
      death: q('.aott-death'), deathKick: q('.aott-death-k'), deathTitle: q('.aott-death-title'),
      deathKills: q('[data-d="kills"]'), deathScore: q('[data-d="score"]'), deathTime: q('[data-d="time"]'),
      deathRetry: q<HTMLButtonElement>('.aott-retry'), deathMenu: q<HTMLButtonElement>('.aott-death-menu'),
      deathNext: q<HTMLButtonElement>('.aott-death-next'),
      missions: q('.aott-missions'), mlist: q('.aott-mlist'),
      result: q('.aott-result'), resultCard: q('.aott-result-card'), resultTitle: q('.aott-result-h'),
      resultTime: q('.aott-time'), resultBest: q('[data-r="best"]'), resultCuts: q('[data-r="cuts"]'),
      resultAvg: q('[data-r="avg"] span'),
      keys: q('.aott-keys'), kb: q('.aott-kb'),
    };
    this._tgts = this.el.tgts.map((node) => ({ node, x: NaN, y: NaN, on: null, att: null }));
    this._buildKeys();
    this._paintKeys();
    keys.onChange(() => { this._paintKeys(); this._c.hint = null; this._hintObj = undefined; });

    // menu sounds: a tick when the pointer comes onto a button, a clack when one is pressed
    this.root.addEventListener('click', (e) => { if ((e.target as Element | null)?.closest('button')) game.audio?.uiClick?.(); }, true);
    this.root.addEventListener('pointerover', (e) => {
      const b = (e.target as Element | null)?.closest('button');
      if (b && !b.contains(e.relatedTarget as Node | null)) game.audio?.uiHover?.();
    });
    // Buttons blur after a click so a later Space/Enter cannot re-click them.
    const press = (node: HTMLElement, fn: () => void): void => {
      node.addEventListener('click', (e) => { (e.currentTarget as HTMLElement).blur(); fn(); });
    };
    this.el.menu.addEventListener('click', (e) => {
      const b = (e.target as Element | null)?.closest<HTMLElement>('[data-mode]');
      if (!b) return;
      b.blur();
      const mode = (b.getAttribute('data-mode') || 'free') as PlayMode;
      this.hideMenu();
      this._onStart?.(mode);
    });
    press(q('.aott-resume'), () => { this.hidePause(); this._onResume?.(); });
    // Restart / Quit: unpause first, then hand over to the game flow (a mission restarts from its current chapter)
    press(q('.aott-restart'), () => {
      const g = this.game, mode = g.mode;
      this.hidePause(); g.paused = false;
      if (mode !== 'menu') trackRestart(mode, g.flow.chapter, g.flow.wave);
      if (mode !== 'menu') g.flow.start(mode, { chapter: g.flow.chapter });
    });
    press(q('.aott-quit'), () => { const g = this.game; this.hidePause(); g.paused = false; g.flow.toMenu(); });
    press(this.el.deathRetry, () => { this.hideDeath(); this._onRetry?.(); });
    press(this.el.deathMenu, () => { this.hideDeath(); this._onMenu?.(); });
    press(this.el.deathNext, () => { this.hideDeath(); this._onNext?.(); });
    press(q('[data-act="missions"]'), () => this.showMissions());
    press(q('[data-act="missions-back"]'), () => this.hideMissions());
    this.el.mlist.addEventListener('click', (e) => {
      const b = (e.target as Element | null)?.closest<HTMLButtonElement>('[data-mission]');
      if (!b || b.disabled) return;
      b.blur();
      this.hideMissions(); this.hideMenu();
      this._onStart?.((b.getAttribute('data-mission') || 'free') as PlayMode, { chapter: +(b.getAttribute('data-ch') || 0) });
    });
    press(q('[data-act="again"]'), () => { this.hideTrainingResult(); this._onAgain?.(); });
    press(q('[data-act="menu"]'), () => { this.hideTrainingResult(); this._onResultMenu?.(); });
    for (const b of all('.aott-keys-btn')) press(b, () => this.showKeys());
    press(q('[data-act="keys-back"]'), () => this.hideKeys());
    press(q('[data-act="keys-reset"]'), () => { this._wait = null; keys.reset(); });

    // Keyboard-only play: on a full screen, arrows move a highlight between its buttons and Enter presses it.
    // (Space is never used here: it is the cut key and may still be mashed when a screen appears.)
    try {
      // capture phase: while the KEYS screen is up it takes every key first (no pause, mute, ... behind it)
      addEventListener('keydown', (e) => this._keysKey(e), true);
      addEventListener('keydown', (e) => this._screenKey(e));
      addEventListener('resize', () => { this._vw = innerWidth; this._vh = innerHeight; });
    } catch { /* no window */ }
  }

  /** Per-frame HUD refresh. Only changed values touch the DOM. */
  update(s: HudState | null | undefined): void {
    if (!s) return;
    const c = this._c, el = this.el;

    // mode + wave (top-left)
    const label = MODE_LABEL[s.mode] || '';
    const wave = s.mode === 'expedition' && Number(s.wave) > 0 ? 'Wave ' + count(s.wave) : '';
    const modeKey = label + '\u0001' + wave;
    if (c.mode !== modeKey) { c.mode = modeKey; el.modeName.textContent = label; el.modeSub.textContent = wave; }

    // HP: a thin bar; a hit flashes it (and the screen edge) oxblood
    const hp = frac(s.hp, 1);
    if (c.hp !== hp) {
      if (hp < c.hp - 0.003 && s.playing) this._hurt();
      c.hp = hp;
      el.hpFill.style.transform = 'scaleX(' + hp + ')';
      el.status.setAttribute('data-low', hp < 0.3 ? '1' : '0');
      const pct = Math.ceil(hp * 100 - 1e-6);
      if (c.hpPct !== pct) { c.hpPct = pct; el.hpVal.textContent = String(pct); }
    }

    // gas: one segmented bar, amber, oxblood when nearly dry
    const gas = frac(s.gas, 0);
    if (c.gas !== gas) {
      c.gas = gas;
      el.gasFill.style.transform = 'scaleX(' + gas + ')';
      const lv = gas < 0.2 ? 'low' : gas < 0.5 ? 'mid' : 'ok';
      if (c.gasLv !== lv) { c.gasLv = lv; el.gas.setAttribute('data-lv', lv); }
      const pct = Math.round(gas * 100);
      if (c.gasPct !== pct) { c.gasPct = pct; el.gasVal.textContent = String(pct); }
    }

    // blades: the pair in hand (sharpness) + spares
    const blade = frac(s.blade, 1);
    if (c.blade !== blade) {
      c.blade = blade;
      for (const f of el.bladeFill) f.style.transform = 'scaleX(' + blade + ')';
      const low = blade < 0.25;
      if (c.bladeLow !== low) { c.bladeLow = low; el.blades.classList.toggle('low', low); }
    }
    const swap = !!s.swapping;
    if (c.swap !== swap) { c.swap = swap; el.blades.classList.toggle('swap', swap); }
    const spare = count(s.bladesSpare);
    if (c.spare !== spare) { c.spare = spare; el.spare.textContent = String(spare); }

    const kmh = Math.round(Math.max(0, Number(s.speed) || 0) * 3.6);
    if (c.kmh !== kmh) {
      c.kmh = kmh;
      el.speed.textContent = String(kmh);
      el.speedFill.style.transform = 'scaleX(' + Math.round(clamp(kmh / SPEED_BAR_MAX, 0, 1) * 200) / 200 + ')';
    }

    const kills = count(s.kills);
    if (c.kills !== kills) { c.kills = kills; el.kills.textContent = String(kills); }
    const score = Math.max(0, Math.round(Number(s.score) || 0));
    if (c.score !== score) { c.score = score; el.score.textContent = score.toLocaleString('en-US'); }

    const combo = count(s.combo);
    if (c.combo !== combo) {
      const prev = c.combo || 0;
      c.combo = combo;
      el.combo.textContent = combo > 1 ? '×' + combo + ' combo' : '';
      el.combo.classList.toggle('on', combo > 1);
      if (combo > prev && combo > 1) this._pop(el.combo);
    }

    const obj = s.objective ? String(s.objective) : '';
    if (c.obj !== obj) {
      c.obj = obj;
      el.objText.textContent = obj;
      el.obj.classList.toggle('on', obj.length > 0);
    }

    const hooks = s.hooks || [];
    for (let i = 0; i < 2; i++) {
      const st = hooks[i]?.state || 'idle';
      if (c.hooks[i] !== st) { c.hooks[i] = st; el.hooks[i].setAttribute('data-state', st); }
    }

    const aim = s.aim;
    const valid = !!aim?.valid;
    const lock = !!aim?.lockTitan;
    const aimKey = (valid ? 1 : 0) + (lock ? 2 : 0);
    if (c.aim !== aimKey) {
      c.aim = aimKey;
      el.ret.setAttribute('data-valid', valid ? '1' : '0');
      el.ret.setAttribute('data-lock', lock ? '1' : '0');
    }
    const dist = valid ? Math.round(Math.max(0, Number(aim.distance) || 0)) : -1;
    if (c.dist !== dist) { c.dist = dist; el.dist.textContent = dist >= 0 ? dist + ' m' : ''; }

    this._updateNapes(s.napeMarkers);
    this._updateHookTargets(s.hookTargets);
    this._updateThreats(s.threats);
    this._updateHint(s.hint);

    // training clock + dummies (top-right)
    const tt = tenths(s.timer);
    if (c.timer !== tt) {
      c.timer = tt;
      el.timer.textContent = fmtClock(tt);
      el.timerRow.hidden = tt < 0;
    }
    const tg = s.targets;
    const tgKey = tg && Number.isFinite(Number(tg.left))
      ? Math.max(0, Math.round(Number(tg.left))) + ' / ' + Math.max(0, Math.round(Number(tg.total) || 0)) : '';
    if (c.targets !== tgKey) {
      c.targets = tgKey;
      el.targets.textContent = tgKey;
      el.targetsRow.hidden = !tgKey;
    }
    const trOn = tt >= 0 || !!tgKey;
    if (c.trOn !== trOn) { c.trOn = trOn; el.tr.classList.toggle('on', trOn); this.root.classList.toggle('tr-on', trOn); }

    const cc = !!s.controlsCard;
    if (c.cc !== cc) { c.cc = cc; el.cc.classList.toggle('on', cc); }

    // kill cam / cutscene: a clean frame (see .cine)
    const cine = !!s.cinematic;
    if (c.cine !== cine) { c.cine = cine; this.root.classList.toggle('cine', cine); }
    // grabbed: MASH + struggle bar
    const grabbed = !!s.grabbed;
    if (c.grabbed !== grabbed) { c.grabbed = grabbed; this.root.classList.toggle('grabbed', grabbed); }
    const struggle = grabbed ? frac(s.struggle, 0) : 0;
    if (c.struggle !== struggle) { c.struggle = struggle; el.grabFill.style.transform = 'scaleX(' + struggle + ')'; }
  }

  /** Training Yard results. onRetry() after RUN AGAIN, onMenu() after MENU. */
  showTrainingResult(r: TrainingResult | null | undefined, onRetry?: (() => void) | null, onMenu?: (() => void) | null): void {
    const st = r || {};
    const el = this.el;
    this._onAgain = onRetry || null;
    this._onResultMenu = onMenu || null;
    const cuts = Math.max(0, Math.round(Number(st.cuts) || 0));
    const total = Math.max(0, Math.round(Number(st.total) || 0));
    el.resultTitle.textContent = total > 0 && cuts < total ? 'Time’s up' : 'Course cleared';
    el.resultTime.textContent = fmtClock(tenths(st.time));
    el.resultBest.textContent = fmtClock(tenths(st.best));
    el.resultCuts.textContent = total > 0 ? cuts + ' / ' + total : String(cuts);
    el.resultAvg.textContent = String(Math.max(0, Math.round(Number(st.avgSpeed) || 0)));
    el.resultCard.classList.toggle('rec', !!st.newBest);
    el.pause.classList.remove('on');
    el.death.classList.remove('on');
    el.result.classList.add('on');
    this._sel = 0;
    this._syncHud();
  }

  hideTrainingResult(): void {
    this.el.result.classList.remove('on');
    this._syncHud();
  }

  /** Damage number that pops at screen (x, y) px, then floats up and fades (~1.2 s). */
  damageNumber(value: number, screenX: number, screenY: number, kill?: boolean): void {
    const layer = this.el.dmgs;
    while (layer.childElementCount > 40) layer.firstElementChild?.remove();
    const d = document.createElement('div');
    d.className = kill ? 'aott-dmg kill' : 'aott-dmg';
    const text = String(Math.round(Number(value) || 0));
    d.textContent = text;
    // never on top of one still showing (two quick cuts on the same nape would otherwise merge into one long number):
    // drop it below whichever it would overlap (the older one is floating up out of the way). Sizes are estimated from
    // the font (no layout read)
    const now = wallMs(), live = this._dmgLive;
    for (let i = live.length - 1; i >= 0; i--) if (now - live[i].t > 900 || !live[i].d.isConnected) live.splice(i, 1);
    const fs = kill ? 50 : 30, w = text.length * fs * 0.6 + 12, h = fs * 0.95;
    const x = screenX;
    let y = screenY;
    for (let tries = 0; tries < 8; tries++) {
      const o = live.find((b) => Math.abs(b.x - x) < (b.w + w) / 2 && Math.abs(b.y - y) < (b.h + h) / 2);
      if (!o) break;
      y = o.y + (o.h + h) / 2 + 2;
    }
    live.push({ d, x, y, w, h, t: now });
    d.style.left = Math.round(x) + 'px';
    d.style.top = Math.round(y) + 'px';
    layer.appendChild(d);
    later(() => d.remove(), 1300);
  }

  /** Right-hand feed line: squad radio ('radio'), kills ('kill'), trouble ('warn'). `who` is shown bold. */
  feed(text: string, kind: FeedKind | string = 'info', who = ''): void {
    const box = this.el.feed;
    const d = document.createElement('div');
    d.className = kind;
    if (who) { const b = document.createElement('b'); b.textContent = who + ': '; d.appendChild(b); }
    d.appendChild(document.createTextNode(String(text)));
    box.appendChild(d);
    while (box.children.length > 5) box.firstChild?.remove();
    requestAnimationFrame(() => d.classList.add('on'));
    later(() => { d.classList.remove('on'); later(() => d.remove(), 300); }, kind === 'warn' ? 6000 : 4500);
  }

  /** A subtitle at the bottom of the screen: `who` speaks `text` (no `who`: the narrator). Replaces the last one. */
  subtitle(who: string | null | undefined, text: string, seconds = 3): void {
    const el = this.el;
    el.subWho.textContent = who || '';
    el.subWho.hidden = !who;
    el.subText.textContent = String(text);
    el.sub.classList.toggle('narr', !who);
    el.sub.classList.add('on');
    clearTimeout(this._subT);
    this._subT = window.setTimeout(() => el.sub.classList.remove('on'), seconds * 1000);
  }
  /** Fade the screen to black (a cut between scenes) or back. */
  fade(on: boolean): void { this.el.fade.classList.toggle('on', !!on); }
  hideSubtitle(): void { clearTimeout(this._subT); this.el.sub.classList.remove('on'); }

  /** Centre-top toast (info / warn), or a huge cinematic line in the middle of the screen (big). */
  message(text: string, seconds = 2.5, style: MessageStyle | string = 'info'): void {
    const dur = Math.max(0.3, Number(seconds) || 2.5) * 1000;
    if (style === 'big') {
      const el = this.el.big;
      this.el.bigText.textContent = String(text);
      el.classList.remove('on');
      cancelAnimationFrame(this._bigRaf);
      // restart the entrance without forcing a layout
      this._bigRaf = requestAnimationFrame(() => { this._bigRaf = requestAnimationFrame(() => el.classList.add('on')); });
      clearTimeout(this._t.big);
      this._t.big = window.setTimeout(() => el.classList.remove('on'), dur);
      return;
    }
    const el = this.el.toast;
    el.textContent = String(text);
    el.classList.remove('on', 'info', 'warn');
    el.classList.add(style === 'warn' ? 'warn' : 'info');
    cancelAnimationFrame(this._toastRaf);
    this._toastRaf = requestAnimationFrame(() => { this._toastRaf = requestAnimationFrame(() => el.classList.add('on')); });
    clearTimeout(this._t.toast);
    this._t.toast = window.setTimeout(() => el.classList.remove('on'), dur);
  }

  /** Take down the centre-top toast now if its text matches `re` (omit for any). */
  clearMessage(re?: RegExp): void {
    const el = this.el.toast;
    if (!el.classList.contains('on') || (re && !re.test(el.textContent || ''))) return;
    cancelAnimationFrame(this._toastRaf);
    clearTimeout(this._t.toast);
    el.classList.remove('on');
  }

  /**
   * Title screen. onStart(mode, opts) is called with 'expedition', 'training' or 'free', or with a mission's id and
   * { chapter } from the MISSIONS screen.
   */
  showMenu(onStart?: StartFn | null, missions?: readonly HudMission[] | null): void {
    this._onStart = onStart || null;
    if (missions) this._missions = missions;
    this.el.menu.classList.add('on');
    this._sel = 0;
    this._syncHud();
  }

  /** The MISSIONS screen: each mission's chapters in story order, the locked ones greyed out. */
  showMissions(): void {
    const box = this.el.mlist;
    box.textContent = '';
    for (const m of this._missions) {
      const sec = document.createElement('div'); sec.className = 'aott-mission';
      const h = document.createElement('div'); h.className = 'aott-mission-h';
      const hb = document.createElement('b'), hs = document.createElement('span');
      hb.textContent = m.title; hs.textContent = m.place || '';
      h.append(hb, hs);
      const rows = document.createElement('div'); rows.className = 'aott-rows';
      m.chapters.forEach((c, i) => {
        const b = document.createElement('button');
        b.className = 'aott-row aott-ch' + (c.locked ? ' locked' : '');
        b.setAttribute('data-mission', m.id); b.setAttribute('data-ch', String(i));
        b.disabled = !!c.locked;
        b.innerHTML = '<i></i><span><b></b><small></small></span>' + ROW_ARROW;
        const [n, body] = [b.children[0], b.children[1]];
        n.textContent = String(i + 1).padStart(2, '0');
        body.children[0].textContent = c.title;
        body.children[1].textContent = c.locked ? 'Locked · finish the chapter before it' : c.desc || '';
        rows.appendChild(b);
      });
      sec.append(h, rows);
      box.appendChild(sec);
    }
    this.el.missions.classList.add('on');
    this._sel = 0;
    this._syncHud();
  }
  hideMissions(): void {
    this.el.missions.classList.remove('on');
    this._sel = 0;
    this._syncHud();
  }

  hideMenu(): void {
    this.el.menu.classList.remove('on');
    this._syncHud();
  }

  /** Death (or mission result) screen. onRetry() after the retry button; onMenu() after MENU and onNext() after
   *  NEXT CHAPTER (each shown only when given). */
  showDeath(stats: DeathStats | null | undefined, onRetry?: (() => void) | null, onMenu?: (() => void) | null,
    onNext?: (() => void) | null): void {
    const st = stats || {};
    const el = this.el;
    this._onRetry = onRetry || null;
    this._onMenu = typeof onMenu === 'function' ? onMenu : null;
    this._onNext = typeof onNext === 'function' ? onNext : null;
    el.deathMenu.hidden = !this._onMenu;
    el.deathNext.hidden = !this._onNext;
    el.deathRetry.classList.toggle('primary', !this._onNext);
    this._sel = 0;
    el.deathKick.textContent = st.win ? 'Mission complete' : 'Mission failed';
    el.deathTitle.textContent = st.cause ? String(st.cause) : 'You were eaten';
    el.death.classList.toggle('win', !!st.win);
    el.deathRetry.textContent = st.retryLabel || (st.win ? 'Play again' : 'Return to the wall');
    el.deathKills.textContent = String(count(st.kills));
    el.deathScore.textContent = Math.max(0, Math.round(Number(st.score) || 0)).toLocaleString('en-US');
    el.deathTime.textContent = fmtTime(st.time);
    el.pause.classList.remove('on');
    el.death.classList.add('on');
    this._syncHud();
  }

  hideDeath(): void {
    this.el.death.classList.remove('on');
    this._syncHud();
  }

  /** Pause screen. onResume() after RESUME. */
  showPause(onResume?: (() => void) | null): void {
    this._onResume = onResume || null;
    const [label, wave] = this._c.mode.split('\u0001');
    this.el.pauseKick.textContent = [label, wave].filter((x) => x && x !== '\0').join(' · ');
    this.el.pause.classList.add('on');
    this._sel = 0;
    this._syncHud();
  }

  hidePause(): void {
    this.el.pause.classList.remove('on');
    this._syncHud();
  }

  /** KEYS screen: rebind any action. Opens over the title or pause screen and returns to it. */
  showKeys(): void {
    const el = this.el;
    this._keysFrom = [el.menu, el.pause].find((n) => n.classList.contains('on')) || null;
    this._keysFrom?.classList.remove('on');
    this._wait = null;
    this._paintKeys();
    el.keys.classList.add('on');
    this._sel = 0;
    this._syncHud();
  }

  hideKeys(): void {
    this._wait = null;
    this.el.keys.classList.remove('on');
    this._keysFrom?.classList.add('on');
    this._keysFrom = null;
    this._sel = 0;
    this._syncHud();
  }

  // ---- internals ----

  private _buildKeys(): void {
    let html = '', group = '';
    for (const a of keys.ACTIONS) {
      if (a.group !== group) { group = a.group; html += '<div class="aott-kb-h">' + group + '</div>'; }
      html += '<div class="aott-kb-r"><span>' + a.name + '</span>';
      for (let i = 0; i < keys.SLOTS; i++) html += '<button data-bind="' + a.id + '" data-slot="' + i + '"></button>';
      html += '</div>';
    }
    this.el.kb.innerHTML = html;
    this.el.kb.addEventListener('click', (e) => {
      const b = (e.target as Element | null)?.closest<HTMLButtonElement>('[data-bind]');
      if (!b) return;
      b.blur();
      this._wait = this._wait === b ? null : b;
      this._sel = this._buttons(this.el.keys).indexOf(b);
      this._paintKeys();
      this._markSel();
    });
  }

  /** Redraw every keycap that shows a binding, and the KEYS screen slots. */
  private _paintKeys(): void {
    for (const n of this.root.querySelectorAll<HTMLElement>('[data-k]')) paintKey(n);
    for (const n of this.root.querySelectorAll<HTMLElement>('[data-alt]')) {
      n.style.display = n.querySelector('kbd[data-s]:not([style*="none"])') ? '' : 'none';
    }
    for (const b of this.el.kb.querySelectorAll<HTMLButtonElement>('[data-bind]')) {
      const k: string | null = keys.slotKey(b.getAttribute('data-bind') || '', +(b.getAttribute('data-slot') || 0));
      const wait = b === this._wait;
      b.textContent = wait ? 'press a key' : k ? keys.keyLabel(k) : '—';
      b.classList.toggle('wait', wait);
      b.classList.toggle('empty', !k && !wait);
    }
  }

  /** While the KEYS screen is up: the next key goes to the slot waiting for one; Esc goes back. */
  private _keysKey(e: KeyboardEvent): void {
    if (!this.el.keys.classList.contains('on')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    const w = this._wait;
    if (w) {
      this._wait = null;
      const id = w.getAttribute('data-bind') || '', slot = +(w.getAttribute('data-slot') || 0);
      if (e.code === 'Backspace' || e.code === 'Delete') keys.bind(id, slot, null);
      else if (e.code !== 'Escape' && e.code) keys.bind(id, slot, keys.keyName(e));
      this._paintKeys();
      return;
    }
    if (e.code === 'Escape') { this.hideKeys(); return; }
    this._screenKey(e);
  }

  /** The in-game HUD is hidden behind the title, pause and death screens. */
  private _syncHud(): void {
    this.root.classList.toggle('hud-off', !!this._screen());
    this._markSel();
  }

  /** The full screen currently shown (topmost first), or null. */
  private _screen(): HTMLElement | null {
    const el = this.el;
    for (const n of [el.keys, el.death, el.result, el.pause, el.missions, el.menu]) if (n.classList.contains('on')) return n;
    return null;
  }

  private _buttons(screen: HTMLElement): HTMLButtonElement[] {
    return Array.from(screen.querySelectorAll<HTMLButtonElement>('.aott-row, .aott-btn, .aott-kb-r button'))
      .filter((b) => !b.hidden && !b.disabled);
  }

  private _markSel(): void {
    const screen = this._screen();
    for (const b of this.root.querySelectorAll('button.sel')) b.classList.remove('sel');
    if (!screen) return;
    const btns = this._buttons(screen);
    if (!btns.length) return;
    this._sel = ((this._sel % btns.length) + btns.length) % btns.length;
    const b = btns[this._sel];
    b.classList.add('sel');
    // a long list (missions, keys) scrolls to keep the highlighted row in view
    if (screen.scrollHeight > screen.clientHeight + 4) b.scrollIntoView({ block: 'nearest' });
  }

  /** Arrow keys move the highlighted button on the shown screen; Enter presses it. */
  private _screenKey(e: KeyboardEvent): void {
    const screen = this._screen();
    if (!screen || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.code || e.key;
    let d = 0;
    const act: string | undefined = keys.actionOf(keys.keyName(e));
    if (k === 'ArrowLeft' || k === 'ArrowUp' || act === 'left' || act === 'forward') d = -1;
    else if (k === 'ArrowRight' || k === 'ArrowDown' || act === 'right' || act === 'back') d = 1;
    if (d) {
      if (e.repeat) return;
      this._sel += d;
      this._markSel();
      e.preventDefault();
      return;
    }
    if ((k === 'Enter' || k === 'NumpadEnter') && !e.repeat) {
      const btns = this._buttons(screen);
      const b = btns[this._sel] || btns[0];
      if (b) { e.preventDefault(); b.click(); }
    }
  }

  /** Nape diamonds with their distance, pooled. */
  private _updateNapes(marks: readonly NapeMarker[] | undefined): void {
    let used = 0;
    if (marks) {
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        if (!m || !m.visible) continue;
        const n = this._nape(used++);
        const x = Math.round(m.x), y = Math.round(m.y);
        if (n.x !== x || n.y !== y) { n.x = x; n.y = y; n.node.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }
        const d = Number.isFinite(m.distance) ? Math.round(m.distance) : -1;
        if (n.d !== d) { n.d = d; n.label.textContent = d >= 0 ? d + 'm' : ''; }
        if (!n.on) { n.on = true; n.node.style.display = 'block'; }
      }
    }
    for (let i = used; i < this._napes.length; i++) {
      const n = this._napes[i];
      if (n.on) { n.on = false; n.node.style.display = 'none'; }
    }
  }

  /** Rope target brackets: index 0 = left rope, 1 = right. Hidden unless visible and valid (or attached). */
  private _updateHookTargets(list: readonly HookTargetMarker[] | undefined): void {
    for (let i = 0; i < 2; i++) {
      const t = this._tgts[i];
      const m = list?.[i];
      const x = m ? Math.round(Number(m.x)) : NaN, y = m ? Math.round(Number(m.y)) : NaN;
      const att = !!m?.attached;
      const on = !!(m && m.visible && (m.valid || att)) && Number.isFinite(x) && Number.isFinite(y);
      if (t.on !== on) { t.on = on; t.node.style.display = on ? 'block' : 'none'; }
      if (!on) continue;
      if (t.x !== x || t.y !== y) { t.x = x; t.y = y; t.node.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }
      if (t.att !== att) { t.att = att; t.node.setAttribute('data-att', att ? '1' : '0'); }
    }
  }

  /** Off-screen titans: oxblood chevrons on an ellipse just inside the screen edge, pointing at them. The ellipse keeps
   *  them out of the corners, where the HUD panels sit. */
  private _updateThreats(list: readonly ThreatMarker[] | undefined): void {
    let used = 0;
    if (list && list.length) {
      const vw = this._vw, vh = this._vh, M = 36;
      const cx = vw / 2, cy = vh / 2, rx = Math.max(40, cx - M), ry = Math.max(40, cy - M);
      for (let i = 0; i < list.length && used < 16; i++) {
        const t = list[i];
        if (!t) continue;
        const a = Number(t.angle) || 0;
        const x = Math.round(cx + rx * Math.sin(a)), y = Math.round(cy - ry * Math.cos(a));
        const deg = Math.round(a * 57.29578 / 2) * 2;
        const n = this._threat(used++);
        if (n.x !== x || n.y !== y || n.a !== deg) {
          n.x = x; n.y = y; n.a = deg;
          n.node.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + deg + 'deg)';
        }
        const danger = !!t.danger;
        if (n.danger !== danger) { n.danger = danger; n.node.classList.toggle('danger', danger); }
        if (!n.on) { n.on = true; n.node.style.display = 'block'; }
      }
    }
    for (let i = used; i < this._threats.length; i++) {
      const n = this._threats[i];
      if (n.on) { n.on = false; n.node.style.display = 'none'; }
    }
  }

  private _threat(i: number): ThreatNode {
    while (this._threats.length <= i) {
      const node = document.createElement('div');
      node.className = 'aott-thr';
      node.style.display = 'none';
      node.innerHTML = THREAT_SVG;
      this.el.threatLayer.appendChild(node);
      this._threats.push({ node, x: NaN, y: NaN, a: NaN, danger: false, on: false });
    }
    return this._threats[i];
  }

  private _nape(i: number): NapeNode {
    while (this._napes.length <= i) {
      const node = document.createElement('div');
      node.className = 'aott-nape';
      node.style.display = 'none';
      node.innerHTML = '<i></i><b></b>';
      this.el.napeLayer.appendChild(node);
      this._napes.push({ node, label: node.lastElementChild as HTMLElement, x: NaN, y: NaN, d: NaN, on: false });
    }
    return this._napes[i];
  }

  /** Tutorial prompt bottom-centre: { keys: ['ropeL','ropeR'], text }. A change fades the old one out, then the new in. */
  private _updateHint(h: Hint | null | undefined): void {
    if (h === this._hintObj && (!h || h.text === this._hintTxt)) return;
    this._hintObj = h; this._hintTxt = h?.text;
    const c = this._c;
    const ks: readonly string[] = h && Array.isArray(h.keys) ? h.keys : [];
    const text = h && h.text ? keys.fill(h.text) as string : '';
    const key = h && (text || ks.length) ? ks.join('\u0001') + '\u0002' + text : '';
    if (c.hint === key) return;
    c.hint = key;
    const el = this.el.hint;
    this._hintNext = key ? { keys: ks, text } : null;
    clearTimeout(this._t.hint);
    if (el.classList.contains('on')) {
      el.classList.remove('on');
      this._t.hint = window.setTimeout(() => this._showHint(), 230);
    } else {
      this._showHint();
    }
  }

  private _showHint(): void {
    const h = this._hintNext;
    if (!h) return;
    const el = this.el;
    el.hintKeys.textContent = '';
    for (const k of h.keys) el.hintKeys.appendChild(kbdFor(k));
    el.hintKeys.style.display = h.keys.length ? '' : 'none';
    el.hintText.textContent = h.text;
    requestAnimationFrame(() => requestAnimationFrame(() => el.hint.classList.add('on')));   // fade in, no forced layout
  }

  /** Took damage: the HP bar and the screen edge flash oxblood. */
  private _hurt(): void {
    const el = this.el;
    if (typeof el.hit.animate !== 'function') return;
    el.hit.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 520, easing: 'ease-out' });
    el.hpFill.animate([{ backgroundColor: '#ff6b5c' }, { backgroundColor: '#c4372b', offset: 0.4 }, {}], { duration: 600, easing: 'ease-out' });
  }

  private _pop(node: HTMLElement): void {
    if (typeof node.animate !== 'function' || this._still?.matches) return;
    node.animate(
      [{ transform: 'scale(1.35)', filter: 'brightness(1.6)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
      { duration: 300, easing: 'ease-out' });
  }
}
