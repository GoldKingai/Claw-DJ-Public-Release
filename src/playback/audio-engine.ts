/**
 * Core audio context manager — singleton.
 * Creates and manages a single AudioContext, master gain, crossfader routing,
 * and DJ-style ducking (lowers music when TTS/mic is active).
 */
import { Crossfader } from './crossfader';

class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private crossfader: Crossfader;

  /** Gain nodes that each deck connects into; crossfader controls their levels. */
  private deckGainA: GainNode | null = null;
  private deckGainB: GainNode | null = null;

  /**
   * Music ducking — separate gain node between deck mix and master output.
   * Signal chain: deckGains → musicGain (duckable) → masterGain → destination
   */
  private musicGain: GainNode | null = null;

  /** TTS gain node — TTS audio sources connect here, routed directly to master. */
  private ttsGain: GainNode | null = null;

  // Ducking config
  private _duckLevel = 0.20;      // Music volume while ducked (0-1)
  private _duckRampTime = 0.4;    // Seconds to ramp down
  private _unduckRampTime = 0.8;  // Seconds to ramp back up (slower for smooth return)
  private _isDucked = false;

  constructor() {
    this.crossfader = new Crossfader();
  }

  /**
   * Initialize the AudioContext. Must be called from a user gesture handler.
   * Safe to call multiple times — subsequent calls resume a suspended context.
   */
  async init(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();

      // Master gain → destination
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 1;
      this.masterGain.connect(this.context.destination);

      // Music gain (duckable) → master gain
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = 1;
      this.musicGain.connect(this.masterGain);

      // TTS gain → master gain (bypasses ducking)
      this.ttsGain = this.context.createGain();
      this.ttsGain.gain.value = 1;
      this.ttsGain.connect(this.masterGain);

      // Per-deck gain nodes → music gain (not directly to master)
      this.deckGainA = this.context.createGain();
      this.deckGainB = this.context.createGain();
      this.deckGainA.connect(this.musicGain);
      this.deckGainB.connect(this.musicGain);

      // Apply initial crossfader values
      this.applyCrossfade();
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  /** Get the underlying AudioContext. Throws if not initialised. */
  getContext(): AudioContext {
    if (!this.context) {
      throw new Error('AudioEngine not initialised. Call init() first.');
    }
    return this.context;
  }

  /** Master gain node (for overall volume control). */
  getMasterGain(): GainNode {
    if (!this.masterGain) {
      throw new Error('AudioEngine not initialised. Call init() first.');
    }
    return this.masterGain;
  }

  /** Set master volume (0-1). */
  setMasterVolume(value: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  /**
   * Get the gain node a deck should connect to.
   * @param deck 'A' or 'B'
   */
  getDeckInput(deck: 'A' | 'B'): GainNode {
    if (!this.deckGainA || !this.deckGainB) {
      throw new Error('AudioEngine not initialised. Call init() first.');
    }
    return deck === 'A' ? this.deckGainA : this.deckGainB;
  }

  /**
   * Get the TTS gain node — connect TTS/speech audio sources here.
   * This bypasses the music ducking so speech stays at full volume.
   */
  getTtsInput(): GainNode {
    if (!this.ttsGain) {
      throw new Error('AudioEngine not initialised. Call init() first.');
    }
    return this.ttsGain;
  }

  /** Set TTS output volume (0-1). */
  setTtsVolume(value: number): void {
    if (this.ttsGain) {
      this.ttsGain.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  // ── Ducking ──────────────────────────────────────────────────

  /**
   * Duck the music — smoothly lower music volume for TTS/mic.
   * Like a DJ pulling down the music fader to talk on the mic.
   */
  duck(): void {
    if (!this.musicGain || !this.context || this._isDucked) return;
    this._isDucked = true;

    const now = this.context.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(this._duckLevel, now + this._duckRampTime);

    console.log(`[audio] Ducking music to ${this._duckLevel * 100}% over ${this._duckRampTime}s`);
  }

  /**
   * Unduck the music — smoothly restore music volume after TTS/mic.
   */
  unduck(): void {
    if (!this.musicGain || !this.context || !this._isDucked) return;
    this._isDucked = false;

    const now = this.context.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, now);
    this.musicGain.gain.linearRampToValueAtTime(1, now + this._unduckRampTime);

    console.log(`[audio] Unducking music to 100% over ${this._unduckRampTime}s`);
  }

  /** Whether music is currently ducked. */
  get isDucked(): boolean {
    return this._isDucked;
  }

  /**
   * Configure ducking parameters.
   * @param duckLevel Volume while ducked (0-1, default 0.20)
   * @param rampDown Seconds to ramp down (default 0.4)
   * @param rampUp Seconds to ramp back up (default 0.8)
   */
  setDuckingConfig(duckLevel?: number, rampDown?: number, rampUp?: number): void {
    if (duckLevel !== undefined) this._duckLevel = Math.max(0, Math.min(1, duckLevel));
    if (rampDown !== undefined) this._duckRampTime = Math.max(0.05, rampDown);
    if (rampUp !== undefined) this._unduckRampTime = Math.max(0.05, rampUp);
  }

  // ── Crossfader ───────────────────────────────────────────────

  /** Current crossfader position (0-1). */
  getCrossfadeValue(): number {
    return this.crossfader.getValue();
  }

  /**
   * Set crossfader position.
   * @param value 0 = full Deck A, 0.5 = center, 1 = full Deck B
   */
  setCrossfade(value: number): void {
    this.crossfader.setValue(value);
    this.applyCrossfade();
  }

  /** Apply the current crossfader gains to the deck gain nodes. */
  private applyCrossfade(): void {
    if (this.deckGainA && this.deckGainB) {
      this.deckGainA.gain.value = this.crossfader.getGainA();
      this.deckGainB.gain.value = this.crossfader.getGainB();
    }
  }
}

/** Singleton audio engine instance. */
const audioEngine = new AudioEngine();
export default audioEngine;
