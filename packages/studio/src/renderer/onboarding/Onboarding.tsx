// The first-run tour: a sheet over the app with a rail of lessons, a whiteboard, the narration and the controls.
// Right or Space is next, Left is back, Escape closes. Auto-advance plays the next step by itself a moment after one finishes.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { LESSONS } from './lessons/index.ts';
import { readDoneLessons, writeDoneLessons } from './seen.ts';
import { usePrefersReducedMotion, Whiteboard } from './Whiteboard.tsx';
import './onboarding.css';

export interface OnboardingProps { initialLesson?: number; onClose(): void }

const AUTO_DELAY_MS = 1700;

function Check(): JSX.Element {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Onboarding({ initialLesson = 0, onClose }: OnboardingProps): JSX.Element {
  const [lessonIx, setLessonIx] = useState(() => Math.min(Math.max(initialLesson, 0), LESSONS.length - 1));
  const [step, setStep] = useState(0);
  const [playKey, setPlayKey] = useState(0);
  const [auto, setAuto] = useState(true);
  const [done, setDone] = useState<number[]>(readDoneLessons);
  // The play (lesson, step, replay) that has finished drawing; auto-advance and the end-of-lesson check read it.
  const [settled, setSettled] = useState('');
  const reduced = usePrefersReducedMotion();
  const sheet = useRef<HTMLDivElement>(null);

  const lesson = LESSONS[lessonIx]!;
  const last = lesson.steps.length - 1;
  const lastLesson = lessonIx === LESSONS.length - 1;
  const playId = lessonIx + ':' + step + ':' + playKey;
  const current = lesson.steps[step]!;

  const goTo = useCallback((l: number, s: number): void => { setLessonIx(l); setStep(s); setPlayKey(0); }, []);
  const next = useCallback((): void => {
    if (step < last) setStep(step + 1);
    else if (!lastLesson) goTo(lessonIx + 1, 0);
    else onClose();
  }, [step, last, lastLesson, lessonIx, goTo, onClose]);
  const back = useCallback((): void => {
    if (step > 0) setStep(step - 1);
    else if (lessonIx > 0) goTo(lessonIx - 1, LESSONS[lessonIx - 1]!.steps.length - 1);
  }, [step, lessonIx, goTo]);

  const onStepDone = useCallback((s: number): void => {
    setSettled(lessonIx + ':' + s + ':' + playKey);
    if (s === last) {
      setDone((d) => {
        if (d.includes(lessonIx)) return d;
        const n = [...d, lessonIx];
        writeDoneLessons(n);
        return n;
      });
    }
  }, [lessonIx, playKey, last]);

  // Auto-advance, only within a lesson and never with reduced motion: there the person clicks Next.
  useEffect(() => {
    if (!auto || reduced || settled !== playId || step >= last) return;
    const t = setTimeout(() => setStep((s) => s + 1), AUTO_DELAY_MS);
    return () => clearTimeout(t);
  }, [auto, reduced, settled, playId, step, last]);

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const onButton = e.target instanceof HTMLElement && (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'A');
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
      else if (e.key === ' ' && !onButton) { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onClose]);

  const nextLabel = step < last ? 'Next' : lastLesson ? 'Start making a game' : 'Next lesson';
  const finished = useMemo(() => done.length, [done]);

  return (
    <div className="ob-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ob" ref={sheet} role="dialog" aria-modal="true" aria-label="How Hull works" tabIndex={-1}>
        <nav className="ob-rail" aria-label="Lessons">
          <div className="ob-rail-head">
            <div className="ob-rail-title">How Hull works</div>
            <div className="ob-rail-sub">{finished} of {LESSONS.length} seen</div>
          </div>
          <ol className="ob-lessons">
            {LESSONS.map((l, i) => (
              <li key={l.title}>
                <button type="button" className={'ob-lesson' + (i === lessonIx ? ' on' : '')} aria-current={i === lessonIx ? 'true' : undefined} onClick={() => goTo(i, 0)}>
                  <span className={'ob-tick' + (done.includes(i) ? ' done' : '')}>{done.includes(i) ? <Check /> : i + 1}</span>
                  <span className="ob-lesson-t">{l.title}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="ob-rail-foot">Arrow keys move through the steps. Escape closes.</div>
        </nav>

        <section className="ob-main">
          <div className="ob-stage">
            <div className="ob-paper">
              <Whiteboard lesson={lesson} step={step} playKey={playKey} onStepDone={onStepDone} />
            </div>
          </div>

          <div className="ob-say" aria-live="polite">
            <div className="ob-say-meta">
              <span>{lesson.title} · step {step + 1} of {last + 1}</span>
              <span className="ob-chips" role="group" aria-label="Steps">
                {lesson.steps.map((s, i) => (
                  <button key={s.title} type="button" className={'ob-chip' + (i < step ? ' done' : '') + (i === step ? ' cur' : '')} title={s.title} aria-label={'Step ' + (i + 1) + ': ' + s.title} aria-current={i === step ? 'step' : undefined} onClick={() => { setStep(i); setPlayKey(0); }}>{i + 1}</button>
                ))}
              </span>
            </div>
            <div className="ob-say-title">{current.title}</div>
            <p className="ob-say-text">{current.say}</p>
          </div>

          <div className="ob-controls">
            <button type="button" className="ob-btn" onClick={back} disabled={lessonIx === 0 && step === 0}>Back</button>
            <button type="button" className="ob-btn primary" onClick={next}>{nextLabel}</button>
            <button type="button" className="ob-btn" onClick={() => setPlayKey((k) => k + 1)}>Replay step</button>
            <span className="ob-spacer" />
            <label className={'ob-auto' + (reduced ? ' off' : '')} title={reduced ? 'Off because your system asks for reduced motion' : undefined}>
              <input type="checkbox" checked={auto && !reduced} disabled={reduced} onChange={(e) => setAuto(e.target.checked)} />
              Auto-advance
            </label>
            <button type="button" className="ob-btn ghost" onClick={onClose}>Skip tour</button>
          </div>
        </section>
      </div>
    </div>
  );
}
