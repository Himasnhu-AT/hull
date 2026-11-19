// Whether the person has seen the first-run tour. Kept apart from the UI so any part of the app can ask.

const KEY = 'hull.onboarding.v1';
const DONE_KEY = 'hull.onboarding.done.v1';

export function onboardingSeen(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function markOnboardingSeen(): void {
  try { localStorage.setItem(KEY, '1'); } catch { /* private mode: the tour shows again next time, which is harmless */ }
}

/** Indexes of the lessons the person has watched to the end. */
export function readDoneLessons(): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch { return []; }
}

export function writeDoneLessons(done: readonly number[]): void {
  try { localStorage.setItem(DONE_KEY, JSON.stringify(done)); } catch { /* as above */ }
}
