// The concept's driver: one accent variable on <html>, like Theme::with_accent in the engine.
// Everything that carries the concept reads it: bars, rules, chips, numbers, the hero capture.
import { gsap } from 'gsap';
import { onPage, ease, prefersReducedMotion } from '../engine';
import { accents } from '../data/site';

const KEY = 'hull-accent';
let current = 'shroud';
let picked = false;
// Hovering a swatch previews its accent on the whole page; leaving the picker restores the pick.
let previewing: string | null = null;

const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (id: string) => { try { localStorage.setItem(KEY, id); } catch { /* private mode */ } };

function apply(id: string, animate: boolean) {
  const a = accents.find((x) => x.id === id) ?? accents[0];
  const changed = a.id !== current;
  current = a.id;
  const h = document.documentElement;
  if (animate && !prefersReducedMotion()) gsap.to(h, { '--accent': a.hex, duration: 0.45, ease: ease.soft, overwrite: true });
  else { gsap.killTweensOf(h); h.style.setProperty('--accent', a.hex); }

  document.querySelectorAll<HTMLElement>('[data-accent-pick]').forEach((pick) => {
    pick.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((b) => {
      const on = b.dataset.accent === a.id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const name = pick.querySelector('[data-accent-name]');
    if (name) name.textContent = a.owner ? `${a.name}, ${a.owner}’s theme` : a.name;
  });
  document.querySelectorAll<HTMLElement>('[data-accent-flag]').forEach((el) => {
    el.textContent = a.flag === 'default' ? 'ui_gallery, default theme' : `ui_gallery --accent ${a.flag}`;
  });

  // Hero capture: the new accent's frame wipes in from the left like the selection bar.
  const stack = document.querySelector<HTMLElement>('[data-accent-stack]');
  if (stack) {
    const imgs = [...stack.querySelectorAll<HTMLElement>('[data-accent-shot]')];
    const next = imgs.find((i) => i.dataset.accentShot === a.id);
    if (next) {
      imgs.forEach((i) => i.classList.toggle('is-top', i === next));
      if (animate && changed && !prefersReducedMotion()) {
        gsap.fromTo(next, { clipPath: 'inset(0% 100% 0% 0%)' }, {
          clipPath: 'inset(0% 0% 0% 0%)', duration: 0.7, ease: ease.inOut, overwrite: true,
          onComplete: () => imgs.forEach((i) => i.classList.toggle('is-shown', i === next)),
        });
      } else {
        gsap.set(next, { clipPath: 'inset(0% 0% 0% 0%)' });
        imgs.forEach((i) => i.classList.toggle('is-shown', i === next));
      }
    }
  }
}

// Attract mode, as a game's title screen has: until the visitor picks an accent, the hero cycles
// through the real captures every few seconds. The first click or key stops it for the visit.
// Paused off screen (hidden tabs draw no frames, so it rests there too); off under reduced motion. Nothing is saved.
function attract() {
  const stack = document.querySelector<HTMLElement>('[data-accent-stack]');
  picked ||= !!read();
  if (!stack || picked || prefersReducedMotion()) return;
  const chip = document.querySelector<HTMLElement>('[data-attract]');
  if (chip) chip.hidden = false;
  let visible = true;
  let held = false;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.4 });
  io.observe(stack);
  // The countdown rule under the capture fills toward the next accent.
  const timer = document.querySelector<HTMLElement>('[data-attract-timer]');
  const next = () => {
    if (previewing) return;
    const i = accents.findIndex((a) => a.id === current);
    apply(accents[(i + 1) % accents.length].id, true);
  };
  if (timer) gsap.set(timer, { autoAlpha: 1, scaleX: 0 });
  const tl = gsap.timeline({ repeat: -1, onRepeat: next });
  tl.fromTo(timer ?? {}, { scaleX: 0 }, { scaleX: 1, duration: 3.4, ease: 'none' });
  const sync = () => { if (visible && !held) tl.play(); else tl.pause(); };
  const onKey = (e: KeyboardEvent) => { if (e.key !== 'Tab' && e.key !== 'Shift') stop(); };
  // Focus inside a picker holds the cycle, so the checked swatch never moves under the focus ring.
  const onFocus = (e: FocusEvent) => { held = !!(e.target as HTMLElement).closest?.('[data-accent-pick]'); sync(); };
  const stop = () => {
    tl.kill();
    if (timer) gsap.to(timer, { autoAlpha: 0, duration: 0.3 });
    io.disconnect();
    if (chip) chip.hidden = true;
    removeEventListener('pointerdown', stop);
    removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocus);
  };
  addEventListener('pointerdown', stop);
  addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocus);
  return stop;
}

export function startAccent() {
  document.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const b = (e.target as HTMLElement).closest?.<HTMLButtonElement>('[data-accent-pick] [data-accent]');
    if (!b) return;
    if (!previewing) previewing = current;
    if (b.dataset.accent !== current) apply(b.dataset.accent!, true);
  });
  document.addEventListener('pointerout', (e) => {
    if (!previewing) return;
    const from = (e.target as HTMLElement).closest?.('[data-accent-pick] .swatches');
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.('[data-accent-pick] .swatches');
    if (!from || from === to) return;
    const back = previewing;
    previewing = null;
    if (back !== current) apply(back, true);
  });
  // Clicks and keys, delegated once (pickers exist on every page, inside the pause menu).
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest?.<HTMLButtonElement>('[data-accent-pick] [data-accent]');
    if (!b) return;
    picked = true;
    previewing = null;
    write(b.dataset.accent!);
    apply(b.dataset.accent!, true);
  });
  document.addEventListener('keydown', (e) => {
    const b = (e.target as HTMLElement).closest?.<HTMLButtonElement>('[data-accent-pick] [data-accent]');
    if (!b || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const all = [...b.parentElement!.querySelectorAll<HTMLButtonElement>('[data-accent]')];
    let i = all.indexOf(b);
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = all.length - 1;
    else i = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    picked = true;
    write(all[i].dataset.accent!);
    apply(all[i].dataset.accent!, true);
    all[i].focus();
  });

  onPage(() => {
    // A game page pins its own colour (its real theme); elsewhere the visitor's pick holds.
    const pinned = document.documentElement.dataset.pageAccent;
    const byHex = pinned ? accents.find((a) => a.hex === pinned)?.id : undefined;
    apply(byHex ?? read() ?? 'shroud', false);
    return attract();
  });
}
