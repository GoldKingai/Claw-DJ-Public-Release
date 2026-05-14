/**
 * BPM-to-animation synchronizer.
 * Provides timing utilities for syncing animations to musical beats.
 */

export class BpmSync {
  private bpm: number;
  private beatDuration: number; // seconds per beat

  constructor(bpm: number = 128) {
    this.bpm = bpm;
    this.beatDuration = 60 / bpm;
  }

  /** Update the BPM value. */
  setBpm(bpm: number): void {
    this.bpm = Math.max(1, bpm);
    this.beatDuration = 60 / this.bpm;
  }

  getBpm(): number {
    return this.bpm;
  }

  /** Returns 0-1 phase within the current beat. */
  getBeatPhase(time: number): number {
    return (time % this.beatDuration) / this.beatDuration;
  }

  /** Returns true if we are near the start of a beat within the given threshold (0-1). */
  isOnBeat(time: number, threshold: number = 0.1): boolean {
    const phase = this.getBeatPhase(time);
    return phase < threshold || phase > 1 - threshold;
  }

  /** Returns 0-1 phase within a 4-beat bar. */
  getBarPhase(time: number): number {
    const barDuration = this.beatDuration * 4;
    return (time % barDuration) / barDuration;
  }

  /** Returns the duration of one beat in seconds. */
  getBeatDuration(): number {
    return this.beatDuration;
  }

  /** Returns how many beats have elapsed since time 0. */
  getBeatCount(time: number): number {
    return Math.floor(time / this.beatDuration);
  }
}
