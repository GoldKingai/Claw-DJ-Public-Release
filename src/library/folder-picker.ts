/**
 * Folder Picker Modal
 *
 * Replaces the bare text input in music-library.ts with a real filesystem
 * browser. Shows drives/mount points (Windows: C: D: USB letters / Linux:
 * /media/<user>/*) and lets the user drill into folders to find their music.
 *
 * Backend endpoints used:
 *   GET /api/directories/roots
 *   GET /api/directories/browse?path=<path>
 *   POST /api/directories (when user confirms)
 *
 * Emits 'folder-added' event with { path, added } on success.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

interface Root {
  path: string;
  label: string;
  type: string;
}

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path: string;
  parent: string | null;
  directories: BrowseEntry[];
  audioCount: number;
  error?: string;
}

@customElement('folder-picker')
export class FolderPicker extends LitElement {
  @property({ type: Boolean }) open = false;

  @state() private _roots: Root[] = [];
  @state() private _currentPath: string | null = null;
  @state() private _parent: string | null = null;
  @state() private _directories: BrowseEntry[] = [];
  @state() private _audioCount = 0;
  @state() private _loading = false;
  @state() private _error = '';
  @state() private _adding = false;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.75);
      z-index: 1000;
    }
    :host([open]) {
      display: flex;
    }
    .modal {
      width: min(640px, 92vw);
      max-height: 80vh;
      background: #11141a;
      border: 1px solid #2a3140;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      padding: 16px 20px;
      border-bottom: 1px solid #2a3140;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #161a22;
    }
    h2 {
      margin: 0;
      font-size: 14px;
      color: #e0e7ff;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .close-btn {
      background: transparent;
      border: 1px solid #3a4356;
      color: #9aa7c0;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
    }
    .close-btn:hover {
      border-color: #5a6378;
      color: #fff;
    }
    .body {
      flex: 1;
      overflow-y: auto;
      padding: 12px 0;
    }
    .breadcrumb {
      padding: 8px 20px;
      font-size: 11px;
      color: #6f7c95;
      border-bottom: 1px solid #1c212b;
      word-break: break-all;
      font-family: ui-monospace, 'SF Mono', monospace;
    }
    .breadcrumb strong {
      color: #c8d2eb;
    }
    .roots-list, .folder-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .folder-item, .root-item {
      padding: 10px 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      color: #d0d8ec;
      font-size: 13px;
      border-bottom: 1px solid #161a22;
      transition: background 80ms;
    }
    .folder-item:hover, .root-item:hover {
      background: #1d2330;
    }
    .icon {
      font-size: 16px;
      width: 20px;
      flex-shrink: 0;
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 10px;
      color: #7a8398;
      background: #1c212d;
      padding: 2px 8px;
      border-radius: 3px;
      letter-spacing: 0.05em;
    }
    .badge.usb {
      background: #1d3a2b;
      color: #6cdfa3;
    }
    .badge.drive {
      background: #2a2418;
      color: #ddb55c;
    }
    .up {
      color: #7aa3ff;
      font-weight: 600;
    }
    .empty {
      padding: 24px 20px;
      text-align: center;
      color: #6a7388;
      font-size: 12px;
    }
    .error {
      padding: 12px 20px;
      color: #ff8a8a;
      font-size: 12px;
      background: #2a1717;
      border-top: 1px solid #4a2929;
    }
    footer {
      padding: 14px 20px;
      border-top: 1px solid #2a3140;
      background: #161a22;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .info {
      font-size: 11px;
      color: #8a96b0;
    }
    .info strong {
      color: #6cdfa3;
    }
    button.primary {
      background: linear-gradient(180deg, #2563eb, #1d4ed8);
      border: 1px solid #3b82f6;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    button.primary:hover {
      background: linear-gradient(180deg, #3b82f6, #2563eb);
    }
    button.primary:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #2a3140;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.open) void this._loadRoots();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open && this._roots.length === 0) {
      void this._loadRoots();
    }
  }

  private async _loadRoots(): Promise<void> {
    this._loading = true;
    this._error = '';
    try {
      const res = await fetch('/api/directories/roots');
      if (!res.ok) {
        this._error = `Backend returned ${res.status} ${res.statusText} — is the claw-dj server running?`;
        this._roots = [];
        return;
      }
      const text = await res.text();
      if (!text) {
        this._error = 'Backend returned empty response — is the claw-dj server reachable?';
        this._roots = [];
        return;
      }
      let data: { roots: Root[] };
      try {
        data = JSON.parse(text);
      } catch {
        this._error = 'Backend not reachable (got HTML/empty response instead of JSON). Check VITE_API_HOST in .env.local and that the backend is running.';
        this._roots = [];
        return;
      }
      this._roots = data.roots ?? [];
      this._currentPath = null;
      this._directories = [];
      this._parent = null;
    } catch (e) {
      this._error = `Network error: ${e instanceof Error ? e.message : e}`;
    } finally {
      this._loading = false;
    }
  }

  private async _browse(targetPath: string): Promise<void> {
    this._loading = true;
    this._error = '';
    try {
      const res = await fetch(`/api/directories/browse?path=${encodeURIComponent(targetPath)}`);
      const data = (await res.json()) as BrowseResponse;
      if (data.error) {
        this._error = data.error;
        return;
      }
      this._currentPath = data.path;
      this._parent = data.parent;
      this._directories = data.directories;
      this._audioCount = data.audioCount;
    } catch (e) {
      this._error = `Browse failed: ${e instanceof Error ? e.message : e}`;
    } finally {
      this._loading = false;
    }
  }

  private async _addCurrent(): Promise<void> {
    if (!this._currentPath) return;
    this._adding = true;
    this._error = '';
    try {
      const res = await fetch('/api/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this._currentPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        this._error = data.error ?? `HTTP ${res.status}`;
        return;
      }
      this.dispatchEvent(
        new CustomEvent('folder-added', {
          detail: { path: data.path, added: data.added ?? 0 },
          bubbles: true,
          composed: true,
        })
      );
      this._close();
    } catch (e) {
      this._error = e instanceof Error ? e.message : 'Failed to add folder';
    } finally {
      this._adding = false;
    }
  }

  private _close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private _onBackdrop(e: MouseEvent): void {
    if (e.target === this) this._close();
  }

  render() {
    return html`
      <div class="modal" @click=${(e: Event) => e.stopPropagation()}>
        <header>
          <h2>Add Music Folder</h2>
          <button class="close-btn" @click=${this._close} title="Close">×</button>
        </header>

        ${this._currentPath
          ? html`<div class="breadcrumb">
              📍 <strong>${this._currentPath}</strong>
            </div>`
          : html`<div class="breadcrumb">Pick a drive or mount point to start</div>`}

        <div class="body">
          ${this._loading
            ? html`<div class="empty"><span class="spinner"></span> Loading…</div>`
            : this._currentPath === null
              ? this._renderRoots()
              : this._renderBrowse()}
          ${this._error ? html`<div class="error">⚠ ${this._error}</div>` : nothing}
        </div>

        <footer>
          <div class="info">
            ${this._currentPath
              ? this._audioCount > 0
                ? html`<strong>${this._audioCount}</strong> audio file${this._audioCount === 1 ? '' : 's'} in this folder`
                : html`No audio files directly here (may have audio in subfolders)`
              : 'Choose a drive, then drill into folders'}
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="primary" style="background: #3a4356; border-color: #4a5366;" @click=${this._close}>
              Cancel
            </button>
            <button
              class="primary"
              ?disabled=${!this._currentPath || this._adding}
              @click=${this._addCurrent}
            >
              ${this._adding ? html`<span class="spinner"></span>` : 'Use this folder'}
            </button>
          </div>
        </footer>
      </div>
    `;
  }

  private _renderRoots() {
    if (this._roots.length === 0) {
      return html`<div class="empty">No drives detected</div>`;
    }
    return html`
      <ul class="roots-list">
        ${this._roots.map(
          (r) => html`
            <li class="root-item" @click=${() => this._browse(r.path)}>
              <span class="icon">${r.type === 'usb' ? '💾' : r.type === 'home' ? '🏠' : '💽'}</span>
              <span class="label">${r.label}</span>
              <span class="badge ${r.type}">${r.type}</span>
            </li>
          `
        )}
      </ul>
    `;
  }

  private _renderBrowse() {
    return html`
      <ul class="folder-list">
        ${this._parent
          ? html`
              <li class="folder-item up" @click=${() => this._browse(this._parent!)}>
                <span class="icon">⬆</span>
                <span class="label">.. (up one level)</span>
              </li>
            `
          : html`
              <li class="folder-item up" @click=${this._loadRoots}>
                <span class="icon">⬆</span>
                <span class="label">.. (back to drives)</span>
              </li>
            `}
        ${this._directories.length === 0
          ? html`<li class="empty">No subfolders here</li>`
          : this._directories.map(
              (d) => html`
                <li class="folder-item" @click=${() => this._browse(d.path)}>
                  <span class="icon">📁</span>
                  <span class="label">${d.name}</span>
                </li>
              `
            )}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'folder-picker': FolderPicker;
  }
}
