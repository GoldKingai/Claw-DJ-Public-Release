/**
 * Waveform data provider for UI rendering and VU meters.
 * Wraps an AnalyserNode and exposes convenient typed-array accessors.
 */
export class WaveformAnalyzer {
  private analyser: AnalyserNode;
  private timeDomainBuffer: Float32Array<ArrayBuffer>;
  private frequencyBuffer: Float32Array<ArrayBuffer>;

  constructor(analyser: AnalyserNode) {
    this.analyser = analyser;
    // Default fftSize is 2048 → frequencyBinCount = 1024
    this.timeDomainBuffer = new Float32Array(this.analyser.frequencyBinCount);
    this.frequencyBuffer = new Float32Array(this.analyser.frequencyBinCount);
  }

  /** Set the FFT size (must be a power of 2, 32–32768). Reallocates internal buffers. */
  setFftSize(size: number): void {
    this.analyser.fftSize = size;
    this.timeDomainBuffer = new Float32Array(this.analyser.frequencyBinCount);
    this.frequencyBuffer = new Float32Array(this.analyser.frequencyBinCount);
  }

  /**
   * Get the current time-domain waveform data (values in -1..1).
   * Suitable for drawing waveform displays.
   */
  getTimeDomainData(): Float32Array {
    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    return this.timeDomainBuffer;
  }

  /**
   * Get the current frequency-domain data in dB.
   * Suitable for drawing spectrum / frequency bars.
   */
  getFrequencyData(): Float32Array {
    this.analyser.getFloatFrequencyData(this.frequencyBuffer);
    return this.frequencyBuffer;
  }

  /**
   * Get the current peak level (0-1) suitable for VU meter display.
   * Computed from the time-domain data as the maximum absolute sample value.
   */
  getPeakLevel(): number {
    this.analyser.getFloatTimeDomainData(this.timeDomainBuffer);
    let peak = 0;
    for (let i = 0; i < this.timeDomainBuffer.length; i++) {
      const abs = Math.abs(this.timeDomainBuffer[i]);
      if (abs > peak) {
        peak = abs;
      }
    }
    return peak;
  }

  /** Get the underlying AnalyserNode (e.g. to adjust smoothingTimeConstant). */
  getAnalyserNode(): AnalyserNode {
    return this.analyser;
  }
}
