/**
 * 3-band EQ using BiquadFilterNodes.
 * Chain: input → low shelf (100 Hz) → mid peaking (1 kHz) → high shelf (8 kHz) → output.
 * Gain range: -24 dB to +24 dB.
 */
export class EQProcessor {
  private low: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private high: BiquadFilterNode;

  private static readonly MIN_DB = -24;
  private static readonly MAX_DB = 24;

  constructor(context: AudioContext) {
    // Low shelf — 100 Hz
    this.low = context.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 100;
    this.low.gain.value = 0;

    // Mid peaking — 1 kHz
    this.mid = context.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 1;
    this.mid.gain.value = 0;

    // High shelf — 8 kHz
    this.high = context.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 8000;
    this.high.gain.value = 0;

    // Internal chain
    this.low.connect(this.mid);
    this.mid.connect(this.high);
  }

  private clamp(dB: number): number {
    return Math.max(EQProcessor.MIN_DB, Math.min(EQProcessor.MAX_DB, dB));
  }

  /** Set low shelf gain in dB (-24 to +24). */
  setLow(dB: number): void {
    this.low.gain.value = this.clamp(dB);
  }

  /** Set mid peaking gain in dB (-24 to +24). */
  setMid(dB: number): void {
    this.mid.gain.value = this.clamp(dB);
  }

  /** Set high shelf gain in dB (-24 to +24). */
  setHigh(dB: number): void {
    this.high.gain.value = this.clamp(dB);
  }

  /**
   * Wire a source node through the EQ chain to a destination node.
   * @param source The node feeding into the EQ (e.g. an AnalyserNode output).
   * @param destination The node the EQ output connects to (e.g. a GainNode).
   */
  connect(source: AudioNode, destination: AudioNode): void {
    source.connect(this.low);
    this.high.connect(destination);
  }

  /** Get the input node of the EQ chain (for manual wiring). */
  getInput(): BiquadFilterNode {
    return this.low;
  }

  /** Get the output node of the EQ chain (for manual wiring). */
  getOutput(): BiquadFilterNode {
    return this.high;
  }
}
