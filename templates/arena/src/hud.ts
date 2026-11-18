import { Behaviour } from 'hull';
import type { UiView } from 'hull/ui';
import { Round } from './round.ts';
import { arena } from './tuning.ts';

/**
 * Score and clock, drawn with hull/ui. The page mounts the UI after `ready`, so the first frame that finds it builds
 * the widgets. In Node there is no UI and this does nothing.
 */
export class Hud extends Behaviour {
  private built: UiView | null = null;
  private round!: Round;

  override ready(): void {
    this.round = this.world.find('round')!.get(Round)!;
  }

  override update(): void {
    const ui = (globalThis as { hull?: { ui?: UiView } }).hull?.ui;
    if (!ui || ui === this.built) return;
    this.built = ui;
    const round = this.round;

    const score = ui.root.panel({ anchor: 'top-left', label: 'Score' });
    score.text('GEMS', { muted: true });
    score.title('0').bind(() => round.score, (v) => String(v));

    const clock = ui.root.panel({ anchor: 'top-right', label: 'Time left', width: 200 });
    clock.text('TIME', { muted: true });
    // Whole seconds: the text changes once a second, not every frame.
    clock.title('0').bind(() => Math.ceil(round.timeLeft), (v) => `${v}s`);
    clock.bar({ label: 'Time left', lowBelow: 0.25 }).bind(() => round.timeLeft, () => arena('roundSeconds'));

    const done = ui.root.panel({ anchor: 'center', label: 'Round over' });
    done.title('Time is up');
    done.text('').bind(() => round.score, (v) => `You collected ${v} gems. Press Space to play again.`);
    done.bindVisible(() => round.over);
  }
}
