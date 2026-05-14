import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { libraryService, type TrackInfo, type MusicDirectory } from './library-service.js';
import './track-item.js';
import './folder-picker.js';

@customElement('music-library')
export class MusicLibrary extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;

  @state() private tracks: TrackInfo[] = [];
  @state() private searchQuery = '';
  @state() private loading = false;
  @state() private error = '';
  @state() private loaded = false;
  @state() private directories: MusicDirectory[] = [];
  @state() private showFolders = false;
  @state() private newFolderPath = '';
  @state() private addingFolder = false;
  @state() private folderError = '';
  @state() private folderSuccess = '';
  @state() private pickerOpen = false;
  @state() private sortBy: 'title' | 'artist' | 'bpm' | 'duration' = 'title';

  static styles = css`
    :host {
      display: block;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 420px;
      max-width: 100vw;
      z-index: 1000;
      pointer-events: none;
      font-family: var(--font-body);
    }

    .panel {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border-left: 1px solid var(--panel-border);
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
    }

    :host([open]) .panel {
      transform: translateX(0);
      pointer-events: auto;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--panel-border);
      flex-shrink: 0;
    }

    .header-title {
      flex: 1;
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 2.5px;
      color: var(--text-primary);
    }

    .header-count {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
    }

    .icon-btn {
      width: 28px;
      height: 28px;
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      padding: 0;
    }

    .icon-btn:hover {
      color: var(--text-primary);
      border-color: var(--panel-border-active);
      background: rgba(255, 255, 255, 0.04);
    }

    .icon-btn.active {
      color: var(--neo-cyan);
      border-color: rgba(0, 240, 255, 0.3);
      background: rgba(0, 240, 255, 0.06);
    }

    .icon-btn.spin svg {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ── Folder Management ── */
    .folder-section {
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--panel-border);
      padding: 12px 16px;
      flex-shrink: 0;
    }

    .folder-label {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 8px;
    }

    .folder-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 10px;
    }

    .folder-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .folder-icon {
      color: var(--neo-cyan);
      font-size: 12px;
      flex-shrink: 0;
    }

    .folder-path {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .add-folder-row {
      display: flex;
      gap: 6px;
    }

    .folder-input {
      flex: 1;
      padding: 5px 8px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-primary);
      background: var(--bg-void);
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .folder-input:focus {
      border-color: rgba(0, 240, 255, 0.4);
    }

    .folder-input::placeholder {
      color: var(--text-dim);
    }

    .add-btn {
      padding: 5px 12px;
      font-family: var(--font-display);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1px;
      color: var(--neo-cyan);
      background: rgba(0, 240, 255, 0.08);
      border: 1px solid rgba(0, 240, 255, 0.25);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .add-btn:hover {
      background: rgba(0, 240, 255, 0.15);
      border-color: rgba(0, 240, 255, 0.4);
    }

    .add-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .folder-msg {
      font-family: var(--font-body);
      font-size: 11px;
      margin-top: 6px;
      padding: 4px 8px;
      border-radius: 3px;
    }

    .folder-msg.error {
      color: #ff4466;
      background: rgba(255, 68, 102, 0.08);
    }

    .folder-msg.success {
      color: var(--neo-lime);
      background: rgba(0, 255, 102, 0.08);
    }

    /* ── Search + Sort Bar ── */
    .toolbar {
      display: flex;
      gap: 6px;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--panel-border);
      flex-shrink: 0;
      align-items: center;
    }

    .search-input {
      flex: 1;
      padding: 6px 10px;
      font-family: var(--font-body);
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-void);
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .search-input:focus {
      border-color: rgba(0, 240, 255, 0.4);
    }

    .search-input::placeholder {
      color: var(--text-dim);
    }

    .sort-select {
      padding: 6px 8px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-void);
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      outline: none;
      cursor: pointer;
    }

    .sort-select:focus {
      border-color: rgba(0, 240, 255, 0.4);
    }

    /* ── Track List ── */
    .track-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px 12px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
    }

    .track-list::-webkit-scrollbar {
      width: 5px;
    }

    .track-list::-webkit-scrollbar-track {
      background: transparent;
    }

    .track-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }

    /* ── States ── */
    .status {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      gap: 8px;
      color: var(--text-dim);
      font-size: 12px;
      letter-spacing: 1px;
    }

    .status.error {
      color: #ff4466;
    }

    .status-icon {
      font-size: 28px;
      opacity: 0.5;
    }

    /* ── Footer ── */
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--panel-border);
      flex-shrink: 0;
    }

    .footer-stat {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
    }

    .footer-stat strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .supported-formats {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
      letter-spacing: 0.5px;
    }
  `;

  updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open && !this.loaded) {
      this.loadTracks();
      this.loadDirectories();
    }
  }

  private async loadTracks() {
    this.loading = true;
    this.error = '';
    try {
      this.tracks = await libraryService.getTracks();
      this.loaded = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to load tracks';
    } finally {
      this.loading = false;
    }
  }

  private async loadDirectories() {
    try {
      this.directories = await libraryService.getDirectories();
    } catch {
      // Non-critical — folder list just won't show
    }
  }

  private async handleRefresh() {
    this.loading = true;
    this.error = '';
    try {
      this.tracks = await libraryService.refresh();
      this.loaded = true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Failed to refresh tracks';
    } finally {
      this.loading = false;
    }
  }

  private async handleAddFolder() {
    const dirPath = this.newFolderPath.trim();
    if (!dirPath) return;

    this.addingFolder = true;
    this.folderError = '';
    this.folderSuccess = '';

    try {
      const result = await libraryService.addDirectory(dirPath);
      this.folderSuccess = `Added ${result.added} track${result.added === 1 ? '' : 's'} from folder`;
      this.newFolderPath = '';
      // Refresh tracks and directories
      this.tracks = await libraryService.refresh();
      await this.loadDirectories();
    } catch (e) {
      this.folderError = e instanceof Error ? e.message : 'Failed to add folder';
    } finally {
      this.addingFolder = false;
      // Clear success/error after 4 seconds
      setTimeout(() => {
        this.folderSuccess = '';
        this.folderError = '';
      }, 4000);
    }
  }

  private handleSearch(e: Event) {
    this.searchQuery = (e.target as HTMLInputElement).value;
  }

  private handleSortChange(e: Event) {
    this.sortBy = (e.target as HTMLSelectElement).value as typeof this.sortBy;
  }

  private handleClose() {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private handleTrackDeck(e: CustomEvent<{ trackId: string; deck: 'A' | 'B' }>) {
    const { trackId, deck } = e.detail;
    console.log(`[MusicLibrary] Deck button clicked: trackId=${trackId} deck=${deck} (${this.tracks.length} tracks in cache)`);
    const track = this.tracks.find((t) => t.id === trackId);
    if (!track) {
      console.error(`[MusicLibrary] Track id="${trackId}" not found in cache — possible stale frontend after backend restart. Try Ctrl+Shift+R to hard-refresh.`);
      alert(`Track not found in library (id=${trackId.slice(0,8)}…).\n\nThe backend may have been restarted with new track IDs. Press Ctrl+Shift+R to hard-refresh the page.`);
      return;
    }
    console.log(`[MusicLibrary] Dispatching track-select for "${track.title}"`);
    this.dispatchEvent(
      new CustomEvent('track-select', {
        detail: { track, deck },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleFolderKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') this.handleAddFolder();
  }

  private async _removeFolder(folderPath: string): Promise<void> {
    if (!confirm(`Remove this folder from the library?\n\n${folderPath}\n\n(Tracks indexed under it will be pruned immediately.)`)) {
      return;
    }
    console.log(`[MusicLibrary] DELETE folder: ${folderPath}`);
    this.folderError = '';
    this.folderSuccess = '';
    try {
      const res = await fetch('/api/directories', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      const data = await res.json();
      console.log(`[MusicLibrary] DELETE response: status=${res.status}`, data);
      if (!res.ok) {
        this.folderError = data.error ?? `HTTP ${res.status}`;
        return;
      }
      this.folderSuccess = `Removed: ${data.path ?? folderPath} (pruned ${data.pruned ?? 0} tracks)`;
      await this.loadDirectories();
      console.log(`[MusicLibrary] After reload, directories list has ${this.directories.length} entries:`, this.directories.map(d => d.path));
      this.tracks = await libraryService.refresh();
      console.log(`[MusicLibrary] After refresh, tracks list has ${this.tracks.length} entries`);
    } catch (err) {
      console.error('[MusicLibrary] DELETE failed:', err);
      this.folderError = err instanceof Error ? err.message : 'Failed to remove folder';
    }
    setTimeout(() => {
      this.folderSuccess = '';
      this.folderError = '';
    }, 4000);
  }

  private async _onFolderAdded(e: CustomEvent<{ path: string; added: number }>) {
    const { added } = e.detail;
    this.folderSuccess = `Added ${added} track${added === 1 ? '' : 's'} from folder`;
    this.pickerOpen = false;
    // Refresh tracks + directory list
    try {
      this.tracks = await libraryService.refresh();
      this.loaded = true;
      await this.loadDirectories();
    } catch (err) {
      this.folderError = err instanceof Error ? err.message : 'Refresh failed';
    }
    // Auto-clear status after 4s
    setTimeout(() => {
      this.folderSuccess = '';
      this.folderError = '';
    }, 4000);
  }

  private get filteredTracks(): TrackInfo[] {
    let result = this.tracks;

    // Filter
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase().trim();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.genre.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q)
      );
    }

    // Sort
    const sorted = [...result];
    switch (this.sortBy) {
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'artist':
        sorted.sort((a, b) => a.artist.localeCompare(b.artist));
        break;
      case 'bpm':
        sorted.sort((a, b) => (b.bpm ?? 0) - (a.bpm ?? 0));
        break;
      case 'duration':
        sorted.sort((a, b) => a.duration - b.duration);
        break;
    }

    return sorted;
  }

  render() {
    const filtered = this.filteredTracks;

    return html`
      <div class="panel">
        <!-- Header -->
        <div class="header">
          <span class="header-title">MUSIC LIBRARY</span>
          <span class="header-count">${this.tracks.length} tracks</span>
          <button
            class="icon-btn ${this.showFolders ? 'active' : ''}"
            title="Manage folders"
            @click=${() => (this.showFolders = !this.showFolders)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 4h5l2 2h5v7H2z"/>
              <line x1="2" y1="7" x2="14" y2="7"/>
            </svg>
          </button>
          <button
            class="icon-btn ${this.loading ? 'spin' : ''}"
            title="Refresh library"
            @click=${this.handleRefresh}
            ?disabled=${this.loading}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1.5 8a6.5 6.5 0 0 1 11.3-4.4M14.5 8a6.5 6.5 0 0 1-11.3 4.4"/>
              <polyline points="1.5 3 1.5 6 4.5 6"/>
              <polyline points="14.5 13 14.5 10 11.5 10"/>
            </svg>
          </button>
          <button class="icon-btn" title="Close library" @click=${this.handleClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <line x1="4" y1="4" x2="12" y2="12"/>
              <line x1="12" y1="4" x2="4" y2="12"/>
            </svg>
          </button>
        </div>

        <!-- Folder Management (collapsible) -->
        ${this.showFolders
          ? html`
              <div class="folder-section">
                <div class="folder-label">MUSIC FOLDERS</div>
                ${this.directories.length > 0
                  ? html`
                      <div class="folder-list">
                        ${this.directories.map(
                          (d) => html`
                            <div class="folder-item" style="display: flex; align-items: center; gap: 8px;">
                              <span class="folder-icon">&#128193;</span>
                              <span class="folder-path" style="flex: 1; overflow: hidden; text-overflow: ellipsis;">${d.path}</span>
                              <button
                                class="add-btn"
                                style="padding: 2px 8px; font-size: 11px; background: transparent; color: #ff7676; border-color: #5a2222;"
                                title="Remove this folder from the library"
                                @click=${() => this._removeFolder(d.path)}
                              >REMOVE</button>
                            </div>
                          `
                        )}
                      </div>
                    `
                  : html`<div style="font-size: 11px; color: var(--text-dim); margin-bottom: 8px;">No folders configured</div>`}
                <div class="add-folder-row">
                  <button
                    class="add-btn"
                    style="width: 100%; padding: 10px;"
                    @click=${() => (this.pickerOpen = true)}
                    ?disabled=${this.addingFolder}
                  >
                    📁 BROWSE DRIVES &amp; USB...
                  </button>
                </div>
                <details style="margin-top: 8px;">
                  <summary style="cursor: pointer; font-size: 10px; color: var(--text-dim); padding: 4px 0;">
                    Or paste a path manually
                  </summary>
                  <div class="add-folder-row" style="margin-top: 6px;">
                    <input
                      class="folder-input"
                      type="text"
                      placeholder="/home/user/Music or D:/Music"
                      .value=${this.newFolderPath}
                      @input=${(e: Event) => (this.newFolderPath = (e.target as HTMLInputElement).value)}
                      @keydown=${this.handleFolderKeydown}
                    />
                    <button
                      class="add-btn"
                      @click=${this.handleAddFolder}
                      ?disabled=${this.addingFolder || !this.newFolderPath.trim()}
                    >
                      ${this.addingFolder ? 'SCANNING...' : 'ADD'}
                    </button>
                  </div>
                </details>
                ${this.folderError
                  ? html`<div class="folder-msg error">${this.folderError}</div>`
                  : nothing}
                ${this.folderSuccess
                  ? html`<div class="folder-msg success">${this.folderSuccess}</div>`
                  : nothing}
              </div>
              <folder-picker
                ?open=${this.pickerOpen}
                @folder-added=${this._onFolderAdded}
                @close=${() => (this.pickerOpen = false)}
              ></folder-picker>
            `
          : nothing}

        <!-- Search + Sort -->
        <div class="toolbar">
          <input
            class="search-input"
            type="text"
            placeholder="Search tracks..."
            .value=${this.searchQuery}
            @input=${this.handleSearch}
          />
          <select class="sort-select" @change=${this.handleSortChange}>
            <option value="title" ?selected=${this.sortBy === 'title'}>Title</option>
            <option value="artist" ?selected=${this.sortBy === 'artist'}>Artist</option>
            <option value="bpm" ?selected=${this.sortBy === 'bpm'}>BPM</option>
            <option value="duration" ?selected=${this.sortBy === 'duration'}>Length</option>
          </select>
        </div>

        <!-- Track List or Status -->
        ${this.loading
          ? html`<div class="status"><span class="status-icon">&#9881;</span>SCANNING LIBRARY...</div>`
          : this.error
            ? html`<div class="status error"><span class="status-icon">&#9888;</span>${this.error}</div>`
            : this.tracks.length === 0
              ? html`
                  <div class="status">
                    <span class="status-icon">&#127925;</span>
                    <span>No tracks found</span>
                    <span style="font-size: 11px; color: var(--text-dim);">Add a music folder to get started</span>
                  </div>
                `
              : filtered.length === 0
                ? html`<div class="status"><span class="status-icon">&#128269;</span>No matches for "${this.searchQuery}"</div>`
                : html`
                    <div class="track-list" @load-to-deck=${this.handleTrackDeck}>
                      ${filtered.map(
                        (t) => html`
                          <track-item
                            track-id=${t.id}
                            .title=${t.title}
                            .artist=${t.artist}
                            .duration=${t.duration}
                            .bpm=${t.bpm}
                            .genre=${t.genre}
                          ></track-item>
                        `
                      )}
                    </div>
                  `}

        <!-- Footer -->
        <div class="footer">
          <span class="footer-stat">
            ${filtered.length !== this.tracks.length
              ? html`<strong>${filtered.length}</strong> / ${this.tracks.length}`
              : html`<strong>${this.tracks.length}</strong>`}
            tracks
          </span>
          <span class="supported-formats">MP3 WAV FLAC OGG AAC M4A</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'music-library': MusicLibrary;
  }
}
