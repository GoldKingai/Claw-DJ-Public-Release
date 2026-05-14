/**
 * Crossfader utility with equal-power crossfade curve.
 * 0 = full Deck A, 0.5 = center (both equal), 1 = full Deck B.
 */
export class Crossfader {
  private value: number = 0.5;
  private gainA: number = Math.cos(0.5 * Math.PI * 0.5);
  private gainB: number = Math.sin(0.5 * Math.PI * 0.5);

  /**
   * Set crossfader position.
   * @param value 0 (full A) to 1 (full B)
   */
  setValue(value: number): void {
    this.value = Math.max(0, Math.min(1, value));
    // Equal-power crossfade: cos/sin curves so that combined power stays constant
    this.gainA = Math.cos(this.value * Math.PI * 0.5);
    this.gainB = Math.sin(this.value * Math.PI * 0.5);
  }

  /** Current gain multiplier for Deck A (0-1). */
  getGainA(): number {
    return this.gainA;
  }

  /** Current gain multiplier for Deck B (0-1). */
  getGainB(): number {
    return this.gainB;
  }

  /** Current crossfader position (0-1). */
  getValue(): number {
    return this.value;
  }
}
