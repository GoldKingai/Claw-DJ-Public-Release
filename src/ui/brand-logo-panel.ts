import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('brand-logo-panel')
export class BrandLogoPanel extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--bg-elevated);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      overflow: hidden;
    }

    .logo-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
    }

    .character-wrap {
      width: 100%;
      position: relative;
      overflow: hidden;
      background: #111d33;
    }

    .character-img {
      display: block;
      width: 100%;
      height: auto;
      object-fit: cover;
      object-position: top center;
      max-height: 220px;
      background: #111d33;
    }

    /* Gradient fade at the bottom of the character image */
    .character-wrap::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: linear-gradient(transparent, var(--bg-elevated));
      pointer-events: none;
    }

    .brand-info {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 4px 12px 12px;
    }

    .brand-name {
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 3px;
      color: var(--text-primary);
      text-align: center;
      user-select: none;
    }

    .accent-line {
      width: 30px;
      height: 1px;
      background: var(--neo-cyan);
      opacity: 0.3;
    }

    .brand-sub {
      font-family: var(--font-body);
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 2.5px;
      text-align: center;
    }

    /* Fallback text logo when no image is set */
    .logo-text {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 4px;
      color: var(--text-primary);
      text-align: center;
      user-select: none;
      padding: 24px 12px 8px;
    }
  `;

  /** Path to logo/character image. When empty, shows text fallback. */
  @property({ type: String }) logoSrc = '/branding/flowdj-character.png';

  override render() {
    return html`
      <div class="logo-container">
        ${this.logoSrc
          ? html`
              <div class="character-wrap">
                <img class="character-img" src="${this.logoSrc}" alt="FLOW DJ" />
              </div>
            `
          : html`<span class="logo-text">FLOW DJ</span>`}
        <div class="brand-info">
          <span class="brand-name">FLOW DJ</span>
          <div class="accent-line"></div>
          <span class="brand-sub">24/7 AI Livestream</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'brand-logo-panel': BrandLogoPanel;
  }
}
