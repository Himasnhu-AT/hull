import { describe, expect, it } from 'vitest';
import { readBrief, sectionId, writeSection } from './brief.ts';

const brief = '# Ashblade\n\nA duel game.\n\n## Premise\n\nA monk and a blade.\n\n## Notes from the owner\n\nKeep it short.\n\n## Rules\n\nThree hits.\n';
const ok = (r: ReturnType<typeof writeSection>): string => { if (!r.ok) throw new Error(r.message); return r.text; };

describe('brief split', () => {
  it('has no sections before the file exists', () => {
    expect(readBrief(null)).toEqual({ exists: false, title: '', text: '', sections: [] });
  });
  it('splits at "## " headings, with ids in kebab case', () => {
    const d = readBrief(brief);
    expect(d.title).toBe('Ashblade');
    expect(d.sections.map((s) => [s.id, s.text])).toEqual([['premise', 'A monk and a blade.'], ['notes-from-the-owner', 'Keep it short.'], ['rules', 'Three hits.']]);
    expect(sectionId('Not in the first version')).toBe('not-in-the-first-version');
  });
  it('does not split at a heading inside a code fence', () => {
    const d = readBrief('# T\n\n## Rules\n\n```\n## not a section\n```\n');
    expect(d.sections.map((s) => s.id)).toEqual(['rules']);
  });
});

describe('brief write', () => {
  it('replaces one section and leaves every other byte alone', () => {
    const t = ok(writeSection(brief, { id: 'rules', text: 'Five hits.' }, 'X'));
    expect(t).toBe(brief.replace('Three hits.', 'Five hits.'));
  });
  it('adds a standard section in the standard order, around sections it does not know', () => {
    const t = readBrief(ok(writeSection(brief, { id: 'controls', text: 'WASD.' }, 'X'))).sections.map((s) => s.id);
    // Controls comes after Premise and before Rules; the owner's own section stays where it was.
    expect(t).toEqual(['premise', 'controls', 'notes-from-the-owner', 'rules']);
    expect(readBrief(ok(writeSection(brief, { id: 'not-in-the-first-version', text: 'Online.' }, 'X'))).sections.map((s) => s.id).at(-1)).toBe('not-in-the-first-version');
    expect(readBrief(ok(writeSection(brief, { id: 'what-you-do', text: 'Duel.' }, 'X'))).sections.map((s) => s.id)).toEqual(['premise', 'what-you-do', 'notes-from-the-owner', 'rules']);
  });
  it('starts a file with the project title and puts sections in order whatever order they are written', () => {
    let t = ok(writeSection(null, { id: 'rules', text: 'r' }, 'My game'));
    t = ok(writeSection(t, { id: 'premise', text: 'p' }, 'My game'));
    t = ok(writeSection(t, { id: 'first-playable', text: 'f' }, 'My game'));
    t = ok(writeSection(t, { id: 'cast', text: 'c' }, 'My game'));
    expect(t.startsWith('# My game\n\n## Premise')).toBe(true);
    expect(readBrief(t).sections.map((s) => s.id)).toEqual(['premise', 'cast', 'rules', 'first-playable']);
    expect(readBrief(t).sections[1]!.title).toBe('Cast');
  });
  it('puts a non-standard section last and titles it from its id', () => {
    const t = readBrief(ok(writeSection(brief, { id: 'secrets', text: 's' }, 'X')));
    expect(t.sections.at(-1)).toEqual({ id: 'secrets', title: 'Secrets', text: 's' });
  });
  it('refuses a title that does not match the id, and a heading in the text', () => {
    expect(writeSection(brief, { id: 'rules', title: 'Laws', text: 'x' }, 'X')).toMatchObject({ ok: false });
    expect(writeSection(brief, { id: 'rules', text: '## Oops' }, 'X')).toMatchObject({ ok: false });
  });
});
