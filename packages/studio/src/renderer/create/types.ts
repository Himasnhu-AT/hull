// Shared shapes of the create shell (M11).

/** The five steps of the rail, in order. 'play' is "Play and fix". */
export type Step = 'idea' | 'brief' | 'build' | 'play' | 'share';
export const STEPS: { id: Step; label: string }[] = [
  { id: 'idea', label: 'Idea' }, { id: 'brief', label: 'Brief' }, { id: 'build', label: 'Build' }, { id: 'play', label: 'Play and fix' }, { id: 'share', label: 'Share' },
];

/** The tabs inside Play and fix. */
export type PlayTab = 'play' | 'everything' | 'changes';

/** A piece the person wants to change: it goes to the builder column and, later, with their note to the builder. */
export interface AttachedPiece {
  /** Config id or 'tunables:<block>'. */
  key: string;
  kind: string;
  /** The name in plain words. */
  name: string;
}
