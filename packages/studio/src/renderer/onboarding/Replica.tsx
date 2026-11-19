// The tour's picture: Hull's chat, and nothing else. The idea box starts in the middle; once the prompt is sent it moves
// to the bottom and the conversation grows above it, the way the real home page works: the builder asks, writes the plan,
// you change it and approve, it builds, you play, flag what is off, it fixes, you share. Each step replays its own part
// in short beats over the conversation so far. It is decoration for the narration below it: hidden from assistive tech,
// inert to clicks. Reduced motion shows each step's end state at once. Built from the app's own classes (styles.css).

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { SceneId } from './story.ts';

const VW = 980, VH = 620;
const TYPE_MS = 24;

const IDEA = 'A small arena where I collect gems before the clock runs out';
const EDIT = 'Add three drones that chase me';
const NOTE = 'The jump feels floaty';
const STAGES = ['The world', 'Characters', 'Animations', 'Rules', 'Sounds', 'Effects', 'Screens'];
const PLAN: [string, string][] = [
  ['You', 'A small robot who can run and jump.'],
  ['The goal', 'Collect 20 gems before 60 seconds run out.'],
  ['Enemies', 'None. Just you and the clock.'],
  ['Controls', 'WASD to move, Space to jump.'],
];
const typeMs = (s: string): number => s.length * TYPE_MS + 250;

/** Text that types itself; all of it when `full`. */
function Typed({ text, full }: { text: string; full: boolean }): JSX.Element {
  const [n, setN] = useState(full ? text.length : 0);
  useEffect(() => {
    if (full) { setN(text.length); return; }
    let i = 0;
    const id = setInterval(() => { i += 1; setN(i); if (i >= text.length) clearInterval(id); }, TYPE_MS);
    return () => clearInterval(id);
  }, [full, text]);
  return <>{text.slice(0, n)}{!full && n < text.length && <i className="rp-caret" />}</>;
}

const You = ({ children, chip }: { children: ReactNode; chip?: string }): JSX.Element => (
  <div className="cr-row-item user"><div className="cr-msg you">{children}{chip && <div className="cr-chips"><span className="chip">{chip}</span></div>}</div></div>
);
const Ai = ({ children }: { children: ReactNode }): JSX.Element => <div className="cr-row-item agent"><div className="cr-msg ai">{children}</div></div>;
const Dots = (): JSX.Element => <div className="cr-thinking"><i /><i /><i /></div>;

function Plan({ shown = 4, link = true, changing = false, updated = false }: { shown?: number; link?: boolean; changing?: boolean; updated?: boolean }): JSX.Element {
  return (
    <div className="cr-ui cr-brief">
      <h3>The plan <span className="cr-k">GAME.md</span></h3>
      {PLAN.slice(0, shown).map(([h, t]) => {
        const enemy = h === 'Enemies';
        return (
          <div key={h} className={'cr-bsec rp-rise' + (enemy && changing ? ' rp-hl' : '')}>
            <div className="cr-bsec-h"><b>{h}</b><span style={{ flex: 1 }} />{link && <span className={'cr-link' + (enemy && changing && !updated ? ' rp-press' : '')}>Change</span>}</div>
            <p className="cr-bsec-t">{enemy && updated ? <><s>{t}</s> <span className="rp-new">Three drones that chase you.</span></> : t}</p>
          </div>
        );
      })}
    </div>
  );
}

function Game({ jump }: { jump?: 'floaty' | 'fixed' | undefined }): JSX.Element {
  return (
    <div className="rp-game">
      <div className="rp-sky" /><div className="rp-ground" />
      {[0, 1, 2, 3].map((i) => <span key={i} className="rp-gem" style={{ left: `${42 + i * 11}%` }} />)}
      <span className={'rp-bot' + (jump ? ` jump-${jump}` : '')} />
      <span className="rp-hud">Gems 7 / 20 · 0:41</span>
    </div>
  );
}

/** What one step adds to the conversation, and what the box at the bottom shows, at a beat (`final`: the step's end). */
interface Step { beats: number[]; log(b: number, final: boolean): ReactNode[]; box?(b: number, final: boolean): { text?: ReactNode; press?: boolean } }

const STEPS: Record<SceneId, Step> = {
  'home-type': { beats: [450, typeMs(IDEA)], log: () => [], box: (b, f) => ({ text: b >= 1 ? <Typed text={IDEA} full={f || b >= 2} /> : undefined }) },
  'home-enter': {
    beats: [450, 700, 700],
    log: (b) => (b >= 2 ? [<You key="i">{IDEA}</You>, ...(b < 3 ? [<Dots key="d" />] : [])] : []),
    box: (b) => (b < 2 ? { text: IDEA, press: b >= 1 } : {}),
  },
  ask: {
    beats: [350, 600, 800, 600],
    log: (b) => [
      ...(b >= 1 ? [<Ai key="a">Nice. One question, then I write the plan.</Ai>] : []),
      ...(b >= 2 ? [<div key="q" className="cr-ui rp-rise"><b>Who do you play?</b><div className="cr-opts">{['A small robot', 'A cat', 'Something else'].map((o, i) => <span key={o} className={'btn' + (i === 0 && b >= 3 ? ' rp-press rp-picked' : '')}>{o}</span>)}</div></div>] : []),
      ...(b >= 4 ? [<You key="r">A small robot</You>] : []),
    ],
  },
  plan: { beats: [400, 380, 380, 380, 380], log: (b) => [...(b >= 1 ? [<Ai key="p0">Here is the plan. Change anything you like.</Ai>] : []), ...(b >= 2 ? [<Plan key="p" shown={Math.min(4, b - 1)} link={b >= 5} />] : [])] },
  edit: { beats: [500, typeMs(EDIT), 450], log: (b) => [<Plan key="p" changing={b >= 1 || b === 0} />], box: (b, f) => ({ text: <Typed text={EDIT} full={f || b >= 2} />, press: b >= 3 }) },
  updated: { beats: [300, 800, 500], log: (b) => [<You key="e">{EDIT}</You>, ...(b < 2 ? [<Dots key="d" />] : [<Plan key="p2" changing updated />])] },
  approve: { beats: [350, 800, 500], log: (b) => (b >= 1 ? [<div key="ok" className="cr-ui rp-rise"><b>Does this plan look right?</b><div className="cr-opts"><span className={'btn primary' + (b >= 2 ? ' rp-press' : '')}>Looks right, build it</span><span className="btn">I want to change something</span></div></div>] : []) },
  build: {
    beats: STAGES.map(() => 420),
    log: (b) => [<div key="bd" className="cr-ui rp-rise"><b>Building your game <span className="cr-k">{Math.min(b, 7)} of 7 ready</span></b>
      <ul className="rp-stages">{STAGES.map((s, i) => <li key={s}><i className={'cr-dot ' + (i < b ? 'ready' : i === b ? 'building' : '')} /><span>{s}</span><small>{i < b ? 'checked' : i === b ? 'building' : ''}</small></li>)}</ul></div>],
  },
  play: { beats: [400, 600, 1600], log: (b) => (b >= 1 ? [<div key="pl" className="cr-ui rp-rise"><b>Your game is ready</b><Game jump={b >= 2 ? 'floaty' : undefined} /><div className="cr-opts"><span className={'btn primary' + (b >= 2 ? ' rp-press' : '')}>Play</span></div></div>] : []) },
  off: { beats: [400, typeMs(NOTE), 450, 400], log: (b) => (b >= 3 ? [<You key="n" chip="Frozen at 0:41">{NOTE}</You>] : []), box: (b, f) => (b >= 3 && !f ? {} : f ? {} : { text: b >= 1 ? <Typed text={NOTE} full={b >= 2} /> : undefined, press: b >= 2 }) },
  fix: {
    beats: [700, 600, 1500],
    log: (b) => [...(b < 1 ? [<Dots key="d" />] : [<div key="fx" className="cr-ui rp-rise"><b>Changed the jump</b><div className="rp-change"><span>Jump height</span><s>2.4</s><span className="rp-new">1.6</span></div>{b >= 2 && <Game jump="fixed" />}<span className="cr-hint">Kept in Changes. Put it back any time.</span></div>])],
  },
  share: { beats: [400, 700], log: (b) => (b >= 1 ? [<div key="sh" className="cr-ui rp-rise"><b>Ready to share</b><div className="rp-file"><span className="rp-file-ic">JS</span><span><b>gem-run.js</b><small>One file. Runs on the web and on the desktop.</small></span></div>{b >= 2 && <div className="cr-opts"><span className="btn primary">Open on the web</span><span className="btn">Build for the desktop</span></div>}</div>] : []) },
};

const ORDER = Object.keys(STEPS) as SceneId[];

function Chat({ scene, reduced, onDone }: { scene: SceneId; reduced: boolean; onDone(): void }): JSX.Element {
  const s = STEPS[scene];
  const [beat, setBeat] = useState(reduced ? s.beats.length : 0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (reduced) { done.current(); return; }
    const ts: ReturnType<typeof setTimeout>[] = [];
    let t = 0;
    s.beats.forEach((d, i) => { t += d; ts.push(setTimeout(() => setBeat(i + 1), t)); });
    ts.push(setTimeout(() => done.current(), t + 150));
    return () => ts.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const final = beat >= s.beats.length;
  const ix = ORDER.indexOf(scene);
  // The conversation so far: every earlier step at its end, then this step at its beat. Older lines scroll off the top.
  // The plan is one card that changes, so only its newest form is shown.
  const now = s.log(beat, final);
  const isPlan = (n: ReactNode): boolean => typeof n === 'object' && n !== null && 'type' in n && n.type === Plan;
  const planLater = now.some(isPlan);
  const before = ORDER.slice(0, ix).flatMap((id) => STEPS[id].log(STEPS[id].beats.length, true))
    .filter((n, i, a) => !isPlan(n) || (!planLater && !a.slice(i + 1).some(isPlan)))
    .filter((_, i, a) => i >= a.length - 6);
  const box = s.box ? s.box(beat, final) : {};
  const hero = scene === 'home-type' || (scene === 'home-enter' && beat < 2);
  return (
    <div className={'rp-chat' + (hero ? ' hero' : '')}>
      <div className="rp-head"><b>Gem Run</b><span className="cr-k">Hull builder</span></div>
      <div className="rp-hero-t"><h2>What game do you want to make?</h2><p>Say it in a sentence or two.</p></div>
      <div className="rp-log">{before.map((n, i) => <div key={'b' + i} className="rp-still">{n}</div>)}{now}</div>
      <div className="rp-dock">
        <div className="cmp stack rp-cmp">
          <div className="rp-ta">{box.text ?? <span className="rp-ph">{hero ? 'A small arena where I...' : 'Say what you want next'}</span>}</div>
          <div className="cmp-foot"><span className="mp-chip">Opus 5.5</span></div>
          <span className={'cmp-btn' + (box.press ? ' rp-press' : '') + (box.text ? '' : ' idle')}>↑</span>
        </div>
      </div>
    </div>
  );
}

/** One step of the story, played in a small copy of the chat that fills its box. `playKey` replays it. */
export function Replica({ scene, playKey, reduced, onDone }: { scene: SceneId; playKey: number; reduced: boolean; onDone(): void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (): void => setScale(Math.min(el.clientWidth / VW, el.clientHeight / VH));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="rp-box" ref={box} aria-hidden="true">
      <div className="rp" style={{ width: VW, height: VH, transform: `scale(${scale})` }}>
        <Chat key={scene + ':' + playKey} scene={scene} reduced={reduced} onDone={onDone} />
      </div>
    </div>
  );
}
