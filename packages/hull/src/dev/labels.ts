// What a chip in the "Just now" strip says. One pure function, so the words are decided in one place and tested without a game.
import type { TraceKind } from '../core/trace.ts';

/** The last part of an id: 'sound/sword/hit' -> 'hit', 'anim-graph/hero#attack' -> 'attack'. */
export function lastPart(id: string): string {
  const parts = id.split(/[/#]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? id;
}

/** A file-style name as a person writes it: 'clash-sparks' -> 'Clash sparks', 'lightAttack_2' -> 'Light attack 2'. */
export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s\-_./#]+/).filter((w) => w !== '').join(' ').toLowerCase();
  return words === '' ? name : words[0]!.toUpperCase() + words.slice(1);
}

/**
 * The label for one event. A config's own title wins when it has one (today's schemas have none, so this is the hook for when
 * they do). Otherwise: a sound or effect is its id without the kind ('sound/sword/hit' -> 'Sword hit'); an animation is the state
 * it entered ('anim-graph/hero#light-attack' -> 'Light attack'); a character is its id's last part ('character/aya' -> 'Aya'), or its node's name when it has no id.
 */
export function feedLabel(kind: TraceKind, id: string, node: string | undefined, title?: string): string {
  const t = title?.trim();
  if (t) return t;
  switch (kind) {
    // The character's name, not the node's: the animator often sits on a child called 'model'. An inline character has no id, so its node names it.
    case 'actor': return id.includes('/') ? humanize(lastPart(id)) : node !== undefined && node.trim() !== '' ? node.trim() : humanize(id);
    case 'anim': return humanize(id.includes('#') ? id.slice(id.indexOf('#') + 1) : lastPart(id));
    default: return humanize(id.replace(/^(sound|vfx)\//, ''));
  }
}
