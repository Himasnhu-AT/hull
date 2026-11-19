import type { Enemy, MoveSet } from '../../schema/index.ts';

const KNOWN = new Set(['trace', 'telegraph', 'cancel', 'iframe', 'parry']);

/**
 * What a schema cannot say about a move-set: cancels that name no move, a window that runs past the move, a trace with
 * no window, a finisher that deals nothing. Each sentence names its place (`move-set#/moves/slash/cancelsInto/0`).
 */
export function checkMoveSet(def: MoveSet, at = 'move-set'): string[] {
  const out: string[] = [];
  const names = Object.keys(def.moves);
  for (const [name, m] of Object.entries(def.moves)) {
    const here = at + '#/moves/' + name;
    (m.cancelsInto ?? []).forEach((n, i) => { if (!def.moves[n]) out.push(here + '/cancelsInto/' + i + ': there is no move "' + n + '" (moves: ' + names.join(', ') + ')'); });
    if (m.cancelsInto?.length && !m.windows?.['cancel']) out.push(here + '/windows: cancelsInto needs a cancel window to say when');
    if (m.damage > 0 && !m.windows?.['trace'] && m.windowsFrom !== 'clip' && !m.shoot) out.push(here + '/windows: a move with damage needs a trace window, or nothing can ever hit');
    if (m.stance && def.stances && !def.stances.includes(m.stance)) out.push(here + '/stance: "' + m.stance + '" is not one of the stances (' + def.stances.join(', ') + ')');
    for (const [wn, w] of Object.entries(m.windows ?? {})) {
      if (!KNOWN.has(wn)) continue;
      const list = (typeof w[0] === 'number' ? [w] : w) as readonly (readonly number[])[];
      list.forEach((r, i) => {
        if (r[1]! <= r[0]!) out.push(here + '/windows/' + wn + (list.length > 1 ? '/' + i : '') + ': the window ends before it starts');
        if (r[1]! > m.length + 1e-9) out.push(here + '/windows/' + wn + (list.length > 1 ? '/' + i : '') + ': the window runs past the end of the move (' + m.length + ' s)');
      });
    }
    if (m.input === undefined && m.start !== false) { /* an enemy's move needs no button */ }
  }
  return out;
}

/** Checks an enemy's patterns against its move-set: every step names a move that exists. */
export function checkEnemy(def: Enemy, moves: MoveSet, at = 'enemy'): string[] {
  const out: string[] = [];
  def.patterns.forEach((p, i) => p.steps.forEach((s, j) => {
    if (s.move === undefined) { if (!s.travel) out.push(at + '#/patterns/' + i + '/steps/' + j + ': a step with no move needs a travel'); return; }
    if (!moves.moves[s.move]) out.push(at + '#/patterns/' + i + '/steps/' + j + '/move: there is no move "' + s.move + '" in the move-set (moves: ' + Object.keys(moves.moves).join(', ') + ')');
    if (s.feint !== undefined && moves.moves[s.move] && s.feint >= moves.moves[s.move]!.length) out.push(at + '#/patterns/' + i + '/steps/' + j + '/feint: the feint comes after the move has ended');
  }));
  return out;
}
