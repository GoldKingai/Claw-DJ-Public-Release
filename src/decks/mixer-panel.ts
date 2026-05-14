import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import './fader.js';
import './eq-knob.js';
import './vu-meter.js';

/**
 * Center mixer panel with two channel strips (A & B),
 * EQ knobs, volume faders, VU meters, and a horizontal crossfader.
 */
@customElement('mixer-panel')
export class MixerPanel extends LitElement {
  @property({ type: Number }) peakLevelA = 0;
  @property({ type: Number }) peakLevelB = 0;
  @property({ type: Number }) crossfadeValue = 0.5;

  static styles = css`
    :host {
      display: block;
      height: 100%;
    }

    .mixer {
      background: rgba(5, 10, 22, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(0, 240, 255, 0.12);
      border-radius: var(--radius-lg, 16px);
      padding: var(--space-md, 16px) var(--space-sm, 8px);
      display: flex;
      flex-direction: column;
      gap: var(--space-md, 16px);
      align-items: center;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
      box-shadow:
        0 0 20px rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.05),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }

    .mixer-title {
      font-family: var(--font-display, 'Orbitron', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--text-secondary, #8899aa);
      text-transform: uppercase;
    }

    .channels {
      display: flex;
      gap: var(--space-md, 16px);
    }

    .channel-strip {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-sm, 8px);
      padding: var(--space-sm, 8px);
      border-radius: var(--radius-md, 8px);
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .channel-label {
      font-family: var(--font-display, 'Orbitron', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: var(--neo-cyan, #00ffff);
    }

    .eq-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-xs, 4px);
    }

    .eq-label {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 9px;
      color: var(--text-dim, #556677);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .fader-meter {
      display: flex;
      gap: var(--space-xs, 4px);
      align-items: flex-end;
    }

    .divider {
      width: 1px;
      height: 100%;
      background: var(--holo-border, rgba(0, 255, 255, 0.15));
    }

    .crossfader-section {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-xs, 4px);
      padding-top: var(--space-sm, 8px);
      border-top: 1px solid rgba(var(--neo-cyan-rgb, 0, 255, 255), 0.08);
    }

    .crossfader-label {
      font-family: var(--font-body, 'Rajdhani', sans-serif);
      font-size: 10px;
      color: var(--text-secondary, #8899aa);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .crossfader-labels {
      display: flex;
      justify-content: space-between;
      width: 100%;
      padding: 0 var(--space-xs, 4px);
    }

    .cf-side-label {
      font-family: var(--font-display, 'Orbitron', sans-serif);
      font-size: 9px;
      color: var(--text-dim, #556677);
    }
  `;

  render() {
    return html`
      <div class="mixer">
        <span class="mixer-title">MIXER</span>

        <div class="channels">
          <!-- Channel A -->
          <div class="channel-strip">
            <span class="channel-label">A</span>
            <div class="eq-section">
              <eq-knob label="HI" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('A', 'high', e)}></eq-knob>
              <eq-knob label="MID" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('A', 'mid', e)}></eq-knob>
              <eq-knob label="LO" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('A', 'low', e)}></eq-knob>
            </div>
            <div class="fader-meter">
              <dj-fader
                orientation="vertical"
                .value=${0.75}
                label="VOL"
                @fader-change=${(e: CustomEvent) => this._onVolumeChange('A', e)}
              ></dj-fader>
              <vu-meter .level=${this.peakLevelA}></vu-meter>
            </div>
          </div>

          <div class="divider"></div>

          <!-- Channel B -->
          <div class="channel-strip">
            <span class="channel-label">B</span>
            <div class="eq-section">
              <eq-knob label="HI" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('B', 'high', e)}></eq-knob>
              <eq-knob label="MID" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('B', 'mid', e)}></eq-knob>
              <eq-knob label="LO" .value=${0} @knob-change=${(e: CustomEvent) => this._onEqChange('B', 'low', e)}></eq-knob>
            </div>
            <div class="fader-meter">
              <dj-fader
                orientation="vertical"
                .value=${0.75}
                label="VOL"
                @fader-change=${(e: CustomEvent) => this._onVolumeChange('B', e)}
              ></dj-fader>
              <vu-meter .level=${this.peakLevelB}></vu-meter>
            </div>
          </div>
        </div>

        <div class="crossfader-section">
          <span class="crossfader-label">CROSSFADER</span>
          <dj-fader
            orientation="horizontal"
            .value=${this.crossfadeValue}
            @fader-change=${this._onCrossfadeChange}
          ></dj-fader>
          <div class="crossfader-labels">
            <span class="cf-side-label">A</span>
            <span class="cf-side-label">B</span>
          </div>
        </div>
      </div>
    `;
  }

  private _onVolumeChange(deck: 'A' | 'B', e: CustomEvent) {
    this.dispatchEvent(new CustomEvent('volume-change', {
      detail: { deck, value: e.detail.value },
      bubbles: true,
      composed: true,
    }));
  }

  private _onEqChange(deck: 'A' | 'B', band: 'high' | 'mid' | 'low', e: CustomEvent) {
    this.dispatchEvent(new CustomEvent('eq-change', {
      detail: { deck, band, value: e.detail.value },
      bubbles: true,
      composed: true,
    }));
  }

  private _onCrossfadeChange = (e: CustomEvent) => {
    this.crossfadeValue = e.detail.value;
    this.dispatchEvent(new CustomEvent('crossfade-change', {
      detail: { value: e.detail.value },
      bubbles: true,
      composed: true,
    }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'mixer-panel': MixerPanel;
  }
}
