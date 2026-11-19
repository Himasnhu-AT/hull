import { describe, expect, it } from 'vitest';
import { authorName, fieldName, kindOfKey, parseLine, pieceField, pieceName, plainLine, undoneBy } from './plainNames.ts';

describe('pieceName', () => {
  it('names a piece for a person', () => {
    expect(pieceName('tunables:player')).toBe('Player');
    expect(pieceName('tunables:hud_timer')).toBe('Hud timer');
    expect(pieceName('sound/thud')).toBe('Thud sound');
    expect(pieceName('ui-theme/hud')).toBe('Hud colours');
    expect(pieceName('tuning/arena')).toBe('Arena rules');
    expect(pieceName('vfx/gas-trail')).toBe('Gas trail effect');
    expect(pieceName('character/soldier')).toBe('Soldier');
    expect(pieceName('hull.json')).toBe('Game settings');
    expect(pieceName('sound/thud-sound')).toBe('Thud sound');
  });
  it('finds the kind of an id', () => {
    expect(kindOfKey('sound/thud')).toBe('sound');
    expect(kindOfKey('tunables:player')).toBe('');
  });
});

describe('fieldName', () => {
  it('turns a key or pointer into words', () => {
    expect(fieldName('jumpHeight')).toBe('jump height');
    expect(fieldName('/level')).toBe('level');
    expect(fieldName('/color/accent', 'ui-theme/hud')).toBe('accent');
    expect(fieldName('/color/accent', 'look/day')).toBe('color accent');
    expect(fieldName('/rows/0/x')).toBe('rows row 1 x');
    expect(fieldName('src/tuning.ts')).toBe('src/tuning.ts');
    expect(fieldName('color.accent', 'ui-theme/hud')).toBe('accent');
    expect(fieldName('params.speed.max')).toBe('params speed max');
  });
  it('joins both', () => {
    expect(pieceField('tunables:player', 'jumpHeight')).toBe('Player: jump height');
    expect(pieceField('sound/thud', '/level')).toBe('Thud sound: level');
    expect(pieceField('ui-theme/hud', '/color/accent')).toBe('Hud colours: accent');
  });
});

describe('authorName', () => {
  it('says Builder or You', () => {
    expect(authorName('you')).toBe('You');
    expect(authorName('ai:hull')).toBe('Builder');
    expect(authorName('marl:tuner')).toBe('Builder');
    expect(authorName('disk')).toBe('A file edit');
  });
});

describe('plainLine', () => {
  it('rewrites tunable and config lines', () => {
    expect(plainLine('player.jumpHeight 2 → 1.6')).toBe('Player: jump height 2 → 1.6');
    expect(plainLine('tuning/arena: crateCount 14 → 20')).toBe('Arena rules: crate count 14 → 20');
    expect(plainLine('sound/thud: level 0.8 to 0.5')).toBe('Thud sound: level 0.8 → 0.5');
    expect(plainLine('ui-theme/hud: color.accent "#35e0c2" → "#3be8c8"')).toBe('Hud colours: accent #35e0c2 → #3be8c8');
  });
  it('leaves other lines alone', () => {
    expect(plainLine('src/x.ts changed (+3 -1 lines)')).toBe('src/x.ts changed (+3 -1 lines)');
    expect(plainLine('GAME.md added (5 lines)')).toBe('GAME.md added (5 lines)');
    expect(parseLine('hello')).toBeNull();
  });
});

describe('undoneBy', () => {
  it('finds the old change a put-back turned round', () => {
    expect(undoneBy(['player.jumpHeight 1.6 → 2'], ['player.jumpHeight 2 → 1.6'])).toEqual(['player.jumpHeight 2 → 1.6']);
    expect(undoneBy(['player.jumpHeight 1.6 → 3'], ['player.jumpHeight 2 → 1.6'])).toBeNull();
    expect(undoneBy(['src/x.ts changed'], ['player.jumpHeight 2 → 1.6'])).toBeNull();
  });
});
