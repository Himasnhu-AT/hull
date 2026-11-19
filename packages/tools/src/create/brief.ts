// The brief: GAME.md at the project root, split at its "## " headings (docs/IDEA-TO-PLAY.md section 4.1). Pure text in, text
// out, so the server, the tests and anything else read and edit it the same way. A section nobody asked to change is
// kept byte for byte, including sections this file has never heard of.
import type { BriefDoc, BriefSection } from 'hull/dev/protocol';

/** The sections the builder writes, in the order they appear in the file. */
export const BRIEF_SECTIONS: readonly { id: string; title: string }[] = [
  { id: 'premise', title: 'Premise' },
  { id: 'what-you-do', title: 'What you do' },
  { id: 'controls', title: 'Controls' },
  { id: 'cast', title: 'Cast' },
  { id: 'world', title: 'World' },
  { id: 'rules', title: 'Rules' },
  { id: 'look-and-sound', title: 'Look and sound' },
  { id: 'first-playable', title: 'First playable' },
  { id: 'not-in-the-first-version', title: 'Not in the first version' },
];

/** A section's id: its title in kebab case. */
export const sectionId = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

interface Chunk { id: string; title: string; /** The section as it is in the file, heading to just before the next heading. */ raw: string }
interface Parsed { title: string; /** Everything before the first "## " heading (the title line, any intro). */ head: string; chunks: Chunk[] }

function parse(text: string): Parsed {
  const lines = text.split('\n');
  let title = '';
  let fence = false;
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    if (title === '' && /^# +\S/.test(l)) title = l.replace(/^# +/, '').trim();
    else if (/^## +\S/.test(l)) starts.push(i);
  });
  const head = lines.slice(0, starts[0] ?? lines.length).join('\n');
  const chunks = starts.map((s, k): Chunk => {
    const raw = lines.slice(s, starts[k + 1] ?? lines.length).join('\n');
    const t = lines[s]!.replace(/^## +/, '').trim();
    return { id: sectionId(t), title: t, raw };
  });
  return { title, head, chunks };
}

const bodyOf = (c: Chunk): string => c.raw.split('\n').slice(1).join('\n').trim();

/** GAME.md (or nothing, when the file does not exist) as the protocol's BriefDoc. */
export function readBrief(text: string | null): BriefDoc {
  if (text === null) return { exists: false, title: '', text: '', sections: [] };
  const p = parse(text);
  const sections: BriefSection[] = p.chunks.map((c) => ({ id: c.id, title: c.title, text: bodyOf(c) }));
  return { exists: true, title: p.title, text, sections };
}

const titleFor = (id: string): string => {
  const known = BRIEF_SECTIONS.find((s) => s.id === id);
  if (known) return known.title;
  const t = id.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const chunkText = (title: string, body: string): string => `## ${title}\n\n${body.trim()}\n`;

/** Replaces one section's text, or adds the section in the standard order. Returns the new file text, or a sentence on what is wrong. */
export function writeSection(current: string | null, section: { id: string; title?: string; text: string }, fallbackTitle: string): { ok: true; text: string } | { ok: false; message: string } {
  const id = sectionId(section.id);
  if (id === '') return { ok: false, message: 'the section id is empty (use its title in kebab case, like "what-you-do")' };
  if (section.title !== undefined && sectionId(section.title) !== id) return { ok: false, message: `the title "${section.title}" does not match the id "${id}" (an id is the title in kebab case)` };
  if (/^## /m.test(section.text)) return { ok: false, message: 'the section text has a "## " heading in it: write one section per call, and leave the heading out' };
  const p = parse(current ?? `# ${fallbackTitle}\n`);
  const at = p.chunks.findIndex((c) => c.id === id);
  const fresh = (title: string): string => chunkText(title, section.text);
  if (at >= 0) {
    const old = p.chunks[at]!;
    p.chunks[at] = { ...old, title: section.title ?? old.title, raw: fresh(section.title ?? old.title) };
  } else {
    const rank = BRIEF_SECTIONS.findIndex((s) => s.id === id);
    const chunk: Chunk = { id, title: section.title ?? titleFor(id), raw: fresh(section.title ?? titleFor(id)) };
    let pos = p.chunks.length;
    if (rank >= 0) {
      // After the last standard section that comes before this one; failing that, before the first that comes after it.
      const rankOf = (c: Chunk): number => BRIEF_SECTIONS.findIndex((s) => s.id === c.id);
      let after = -1;
      p.chunks.forEach((c, i) => { const r = rankOf(c); if (r >= 0 && r < rank) after = i; });
      if (after >= 0) pos = after + 1;
      else { const next = p.chunks.findIndex((c) => rankOf(c) > rank); if (next >= 0) pos = next; }
    }
    p.chunks.splice(pos, 0, chunk);
  }
  return { ok: true, text: join(p) };
}

function join(p: Parsed): string {
  const head = p.head.replace(/\n*$/, '');
  const parts = p.chunks.map((c) => c.raw.replace(/\n*$/, ''));
  return [head, ...parts].filter((s) => s !== '').join('\n\n') + '\n';
}
