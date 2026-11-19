// Analytics, switched off in this port: every call is accepted and does nothing, so the game code that reports events
// (mode starts, deaths, waves) is unchanged and no tracking library or network call is part of the Hull build.
type EventData = Record<string, string | number | boolean | null | undefined>;

export function track(_name: string, _data?: EventData): void { /* off */ }
export function tickPlay(_dt: number, _playing: boolean, _mode: string): void { /* off */ }
export function initAnalytics(_info: EventData = {}): void { /* off */ }

export const trackModeStart = (_mode: string, _chapter = 0): void => { /* off */ };
export const trackChapterDone = (_mode: string, _chapter: number): void => { /* off */ };
export function trackDeath(_mode: string, _cause: string, _wave: number, _run: { seconds?: number; kills?: number; score?: number; saved?: number; topSpeed?: number } = {}): void { /* off */ }
export const trackRestart = (_mode: string, _chapter: number, _wave: number): void => { /* off */ };
export const trackWave = (_wave: number): void => { /* off */ };
export const trackRescue = (_mode: string, _total: number): void => { /* off */ };
export function trackMove(_move: string, _mode: string): void { /* off */ }
