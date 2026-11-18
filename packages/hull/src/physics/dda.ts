// Walks the cells of a 2D grid (x and z) that a segment passes through, in order (Amanatides and Woo).
// One instance is reused, so a walk allocates nothing.
export class Dda {
  ix = 0;
  iz = 0;
  /** Parameter at which the walk entered the current cell. */
  tEntry = 0;
  private stepX = 0;
  private stepZ = 0;
  private tMaxX = Infinity;
  private tMaxZ = Infinity;
  private tDx = 0;
  private tDz = 0;
  private tEnd = 0;

  /** Starts a walk of `(ox, oz) + t * (dx, dz)` for t in [0, tEnd], over square cells of side `size`. */
  init(ox: number, oz: number, dx: number, dz: number, tEnd: number, size: number): void {
    this.ix = Math.floor(ox / size);
    this.iz = Math.floor(oz / size);
    this.tEntry = 0;
    this.tEnd = tEnd;
    if (dx > 0) {
      this.stepX = 1;
      this.tMaxX = ((this.ix + 1) * size - ox) / dx;
      this.tDx = size / dx;
    } else if (dx < 0) {
      this.stepX = -1;
      this.tMaxX = (this.ix * size - ox) / dx;
      this.tDx = -size / dx;
    } else {
      this.stepX = 0;
      this.tMaxX = Infinity;
      this.tDx = Infinity;
    }
    if (dz > 0) {
      this.stepZ = 1;
      this.tMaxZ = ((this.iz + 1) * size - oz) / dz;
      this.tDz = size / dz;
    } else if (dz < 0) {
      this.stepZ = -1;
      this.tMaxZ = (this.iz * size - oz) / dz;
      this.tDz = -size / dz;
    } else {
      this.stepZ = 0;
      this.tMaxZ = Infinity;
      this.tDz = Infinity;
    }
  }

  /** Parameter at which the walk leaves the current cell. */
  get tExit(): number {
    return this.tMaxX < this.tMaxZ ? this.tMaxX : this.tMaxZ;
  }

  get stepSignX(): number { return this.stepX; }
  get stepSignZ(): number { return this.stepZ; }

  /** Moves to the next cell. False when the segment ends first. */
  advance(): boolean {
    if (this.tMaxX < this.tMaxZ) {
      if (this.tMaxX > this.tEnd) return false;
      this.tEntry = this.tMaxX;
      this.ix += this.stepX;
      this.tMaxX += this.tDx;
    } else {
      if (this.tMaxZ > this.tEnd || this.tMaxZ === Infinity) return false;
      this.tEntry = this.tMaxZ;
      this.iz += this.stepZ;
      this.tMaxZ += this.tDz;
    }
    return true;
  }
}
