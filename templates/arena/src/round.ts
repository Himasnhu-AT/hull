import { Behaviour } from 'hull';
import { rig } from './rig.ts';
import { arena } from './tuning.ts';

/** The score and the clock. When the clock runs out the round is over until the player presses jump. */
export class Round extends Behaviour {
  static override state = ['score', 'timeLeft', 'over'];
  score = 0;
  timeLeft = 0;
  over = false;

  override ready(): void {
    this.timeLeft = arena('roundSeconds');
  }

  override fixedUpdate(dt: number): void {
    if (this.over) {
      if (rig.input.action('jump').pressed) this.restart();
      return;
    }
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.over = true;
    }
  }

  restart(): void {
    this.score = 0;
    this.timeLeft = arena('roundSeconds');
    this.over = false;
  }
}
