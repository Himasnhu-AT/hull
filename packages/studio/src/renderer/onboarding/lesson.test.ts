import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons/index.ts';
import { opBox, textBox, validateLesson, type Lesson } from './lesson.ts';

const lesson = (steps: Lesson['steps']): Lesson => ({ title: 'T', lang: 'en', steps });
const step = (...ops: Lesson['steps'][number]['ops']): Lesson['steps'][number] => ({ title: 's', say: 'Says one thing.', ops });
const filler = (n: number): Lesson['steps'] => Array.from({ length: n }, (_, i) => step({ op: 'rect', id: 'f' + i, x: 100, y: 100, w: 50, h: 50 }));

describe('the lessons', () => {
  it('has four lessons with titles', () => {
    expect(LESSONS.map((l) => l.title)).toEqual(['What Hull is', 'Every change is safe', 'Play and fix', 'Who builds']);
  });
  for (const l of LESSONS) {
    it('"' + l.title + '" passes the validator', () => {
      expect(validateLesson(l)).toEqual([]);
    });
    it('"' + l.title + '" has 5 to 7 steps, plain narration and big text', () => {
      expect(l.steps.length).toBeGreaterThanOrEqual(5);
      expect(l.steps.length).toBeLessThanOrEqual(7);
      for (const s of l.steps) {
        expect(s.say.length).toBeLessThan(240);
        for (const op of s.ops) if (op.op === 'write') expect(op.size ?? 40).toBeGreaterThanOrEqual(28);
      }
    });
  }
});

describe('validateLesson', () => {
  it('needs 5 to 8 steps', () => {
    expect(validateLesson(lesson(filler(4)))[0]).toContain('4 steps');
    expect(validateLesson(lesson(filler(9)))[0]).toContain('9 steps');
    expect(validateLesson(lesson(filler(5)))).toEqual([]);
  });
  it('limits a step to 12 ops', () => {
    const many = step(...Array.from({ length: 13 }, (_, i) => ({ op: 'rect' as const, id: 'm' + i, x: 100, y: 100, w: 10, h: 10 })));
    expect(validateLesson(lesson([many, ...filler(4)])).join('\n')).toContain('13 ops');
  });
  it('wants unique ids over the whole lesson', () => {
    const l = lesson([...filler(4), step({ op: 'rect', id: 'f0', x: 100, y: 100, w: 5, h: 5 })]);
    expect(validateLesson(l).join('\n')).toContain('id is used twice');
  });
  it('checks colours, sizes and fields', () => {
    const bad = step(
      { op: 'write', id: 'w1', x: 100, y: 100, text: 'Hi', size: 20 },
      { op: 'write', id: 'w2', x: 300, y: 100, text: 'Hi', size: 70 },
      { op: 'rect', id: 'r1', x: 100, y: 300, w: 10, h: 10, color: 'purple' as never },
      { op: 'line', id: 'l1', x1: 100, y1: 300, x2: 'a' as never, y2: 100 },
    );
    const msg = validateLesson(lesson([bad, ...filler(4)])).join('\n');
    expect(msg).toContain('size 20');
    expect(msg).toContain('size 70');
    expect(msg).toContain('purple');
    expect(msg).toContain('x2 must be a number');
  });
  it('keeps everything inside the 40-unit margin', () => {
    const edge = step(
      { op: 'rect', id: 'r1', x: 20, y: 100, w: 100, h: 50 },
      { op: 'write', id: 'w1', x: 1500, y: 300, text: 'twenty characters!!', size: 40 },
      { op: 'write', id: 'w2', x: 800, y: 100, text: 'centred and fine', size: 40, anchor: 'middle' },
    );
    const msg = validateLesson(lesson([edge, ...filler(4)])).join('\n');
    expect(msg).toContain('r1');
    expect(msg).toContain('w1');
    expect(msg).not.toContain('w2');
  });
  it('estimates text width as size times 0.5 per Latin character and 1 per CJK character', () => {
    const b = textBox({ op: 'write', id: 'a', x: 100, y: 100, text: 'abcd\nab', size: 40 });
    expect(b).toEqual({ x: 100, y: 100, w: 80, h: 104 });
    expect(textBox({ op: 'write', id: 'b', x: 100, y: 0, text: '你好', size: 40, anchor: 'middle' }).w).toBe(80);
  });
  it('rejects two text boxes that overlap at the same time, but allows it after an erase', () => {
    const a = { op: 'write' as const, id: 'a', x: 200, y: 200, text: 'Hello there', size: 40 };
    const b = { op: 'write' as const, id: 'b', x: 230, y: 210, text: 'Other words', size: 40 };
    expect(validateLesson(lesson([step(a, b), ...filler(4)])).join('\n')).toContain('overlaps "a"');
    expect(validateLesson(lesson([step(a, { op: 'erase', ids: ['a'] }, b), ...filler(4)]))).toEqual([]);
    expect(validateLesson(lesson([step(a), step({ op: 'erase', all: true }, b), ...filler(3)]))).toEqual([]);
  });
  it('erases by region using the centre of each object', () => {
    const a = { op: 'write' as const, id: 'a', x: 200, y: 200, text: 'Hello', size: 40 };
    const b = { op: 'write' as const, id: 'b', x: 210, y: 205, text: 'Hello', size: 40 };
    const l = lesson([step(a, { op: 'erase', region: { x: 150, y: 150, w: 200, h: 100 } }, b), ...filler(4)]);
    expect(validateLesson(l)).toEqual([]);
  });
  it('flags an erase of something that is not on the board', () => {
    expect(validateLesson(lesson([step({ op: 'erase', ids: ['ghost'] }), ...filler(4)])).join('\n')).toContain('"ghost"');
  });
  it('measures paths, ellipses and arrows', () => {
    expect(opBox({ op: 'path', id: 'p', d: 'M 100 100 L 300 100 V 200 H 150', width: 4 })).toEqual({ x: 98, y: 98, w: 204, h: 104 });
    const e = opBox({ op: 'ellipse', id: 'e', cx: 500, cy: 500, rx: 100, ry: 50, width: 4 })!;
    expect(e.x).toBeCloseTo(398);
    expect(e.w).toBeCloseTo(204);
    const plain = opBox({ op: 'line', id: 'l', x1: 0, y1: 0, x2: 100, y2: 0 })!;
    const arrow = opBox({ op: 'line', id: 'l', x1: 0, y1: 0, x2: 100, y2: 0, arrow: true })!;
    expect(arrow.w).toBeGreaterThan(plain.w);
  });
});
