// Global motion for the site. Runs once on the client before the first page initializes.
import { gsap } from 'gsap';
import { setTransition, ease, onPage, onScroll, prefersReducedMotion } from '../engine';
import { startAccent } from './accent';
import { startMenus } from './menus';
import { startFps } from './fps';
import { startUi } from './ui';

// Screen push: the next screen slides in from the right carrying its title; it leaves to the left.
let nextTitle = '';
function screenTitle(a: HTMLAnchorElement) {
  return a.dataset.screen || a.querySelector('.btn__label')?.textContent || a.textContent?.trim().split('\n')[0] || '';
}

export function setupMotion() {
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a');
    if (a) nextTitle = screenTitle(a as HTMLAnchorElement).trim();
  }, true);

  setTransition({
    leave: (c) => {
      document.dispatchEvent(new CustomEvent('hull:leave'));
      const panel = c.querySelector<HTMLElement>('.curtain__panel')!;
      const title = c.querySelector<HTMLElement>('[data-curtain-title]');
      if (title) title.textContent = nextTitle || 'Loading';
      return gsap.timeline()
        .set(c, { autoAlpha: 1 })
        .fromTo(panel, { xPercent: 100 }, { xPercent: 0, duration: 0.7, ease: ease.inOut })
        .fromTo(c.querySelectorAll('.eyebrow, .curtain__title'), { x: 80, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.6, stagger: 0.05, ease: ease.out }, '-=0.45');
    },
    enter: (c) => {
      const panel = c.querySelector<HTMLElement>('.curtain__panel')!;
      // The title rides out with the panel, so the screen is never blank.
      return gsap.timeline()
        .to(panel, { xPercent: -100, duration: 0.8, ease: ease.inOut })
        .to(c.querySelectorAll('.eyebrow, .curtain__title'), { x: -40, duration: 0.8, ease: ease.inOut }, 0)
        .set(c, { autoAlpha: 0 })
        .set(c.querySelectorAll('.eyebrow, .curtain__title'), { x: 0 })
        .add(() => { nextTitle = ''; });
    },
  });

  startAccent();
  startMenus();
  startFps();
  startUi();

  // Frame: solid behind it once scrolled, steps aside on scroll down, returns on scroll up.
  // The corner state label follows where you are: main menu on the hero, then in game.
  let last = 0;
  const h = document.documentElement;
  onScroll(({ y }) => {
    h.classList.toggle('is-scrolled', y > 24);
    if (Math.abs(y - last) > 4) {
      h.classList.toggle('frame-away', y > 200 && y > last && !h.classList.contains('is-paused'));
      last = y;
    }
    syncState(y);
  });
  onPage(() => {
    h.classList.remove('frame-away', 'is-scrolled');
    syncState(0);
  });
  void prefersReducedMotion;
}

function syncState(y: number) {
  const label = document.querySelector<HTMLElement>('[data-state-label]');
  const main = document.querySelector<HTMLElement>('main');
  if (!label || !main || document.documentElement.classList.contains('is-paused')) return;
  const base = main.dataset.state || 'In game';
  const text = base === 'Main menu' && y > innerHeight * 0.55 ? 'In game' : base;
  if (label.textContent !== text) label.textContent = text;
}
