import { describe, expect, it } from 'vitest';
import { pickTemplate, titleFromIdea } from './idea.ts';

describe('pickTemplate', () => {
  it('sends shooter words to fps', () => {
    expect(pickTemplate('A first-person arena where waves of drones come at me')).toBe('fps');
    expect(pickTemplate('a wave shooter with a rifle')).toBe('fps');
  });
  it('sends sword and action words to third-person', () => {
    expect(pickTemplate('A third-person samurai game on a windy island')).toBe('third-person');
    expect(pickTemplate('a knight with a sword fights ghosts')).toBe('third-person');
  });
  it('lets the stated view decide when both kinds of word appear', () => {
    expect(pickTemplate('third-person shooter')).toBe('third-person');
    expect(pickTemplate('first-person sword fighting')).toBe('fps');
  });
  it('falls back to the arena', () => {
    expect(pickTemplate('Run and jump to collect gems before the clock runs out')).toBe('arena');
    expect(pickTemplate('')).toBe('arena');
  });
});

describe('titleFromIdea', () => {
  it('keeps the first few meaningful words', () => {
    expect(titleFromIdea('A third-person samurai game on a windy island. One swordswoman against raiders.')).toBe('Third-person Samurai Windy Island');
  });
  it('has a fallback and a limit', () => {
    expect(titleFromIdea('   ')).toBe('My Game');
    expect(titleFromIdea('Extraordinarily Incomprehensibilities Unquestionably Disproportionately Long').length).toBeLessThanOrEqual(40);
  });
});
