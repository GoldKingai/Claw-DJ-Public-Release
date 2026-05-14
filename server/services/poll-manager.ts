/**
 * Poll Manager
 *
 * Manages live polls for YouTube chat audience engagement.
 * Viewers vote by typing option letters (A, B, C, D) in chat.
 *
 * A poll runs for a fixed window (default 60s), then closes automatically.
 * The watchdog or AI agent calls startPoll(); youtube-chat feeds votes
 * to recordVote() as messages arrive.
 */

export interface PollOption {
  letter: string;   // 'A' | 'B' | 'C' | 'D'
  text: string;
  votes: number;
}

export interface PollState {
  active: boolean;
  question: string;
  options: PollOption[];
  durationMs: number;
  startedAt: number;       // ms epoch, 0 if no active poll
  endsAt: number;          // ms epoch
  votedUsers: string[];    // users who already voted (dedupe)
  winner: PollOption | null; // set when poll closes
}

const DEFAULT_DURATION_MS = 60_000;

class PollManagerService {
  private _state: PollState = _emptyState();
  private _closeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  get state(): PollState {
    return { ...this._state, options: this._state.options.map(o => ({ ...o })) };
  }

  get isActive(): boolean {
    return this._state.active;
  }

  /**
   * Start a new poll. Closes any existing poll first.
   * @param question The poll question text
   * @param options  2–4 option strings (auto-labeled A, B, C, D)
   * @param durationMs Window in ms (default 60s)
   */
  start(question: string, options: string[], durationMs = DEFAULT_DURATION_MS): PollState {
    if (this._state.active) this.close();

    const letters = ['A', 'B', 'C', 'D'];
    const pollOptions: PollOption[] = options.slice(0, 4).map((text, i) => ({
      letter: letters[i],
      text,
      votes: 0,
    }));

    const now = Date.now();
    this._state = {
      active: true,
      question,
      options: pollOptions,
      durationMs,
      startedAt: now,
      endsAt: now + durationMs,
      votedUsers: [],
      winner: null,
    };

    // Auto-close after duration
    this._closeTimer = setTimeout(() => this.close(), durationMs);

    console.log(`[Poll] Started: "${question}" — ${pollOptions.map(o => `${o.letter}) ${o.text}`).join(' | ')} (${durationMs / 1000}s)`);
    return this.state;
  }

  /**
   * Record a vote from a YouTube chat user.
   * Accepts 'A', 'B', 'C', 'D' (case-insensitive). One vote per user.
   * @returns true if vote was counted, false if rejected
   */
  recordVote(user: string, text: string): boolean {
    if (!this._state.active) return false;
    if (Date.now() > this._state.endsAt) return false;

    // Parse the vote — first word of the message
    const word = text.trim().split(/\s+/)[0].toUpperCase();
    const option = this._state.options.find(o => o.letter === word);
    if (!option) return false;

    // Dedupe per user
    if (this._state.votedUsers.includes(user)) return false;

    option.votes++;
    this._state.votedUsers.push(user);
    console.log(`[Poll] Vote: ${user} → ${word} (total: ${option.votes})`);
    return true;
  }

  /**
   * Close the poll and determine the winner.
   * Safe to call even if no poll is active.
   */
  close(): PollState {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }

    if (!this._state.active) return this.state;

    // Find winner (highest votes; first option wins ties)
    let winner: PollOption | null = null;
    for (const opt of this._state.options) {
      if (!winner || opt.votes > winner.votes) winner = opt;
    }

    this._state.active = false;
    this._state.winner = winner ? { ...winner } : null;

    console.log(`[Poll] Closed — winner: ${winner ? `${winner.letter}) ${winner.text} (${winner.votes} votes)` : 'no votes'}`);
    return this.state;
  }

  /** Reset to empty state (call after presenting results). */
  reset(): void {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    this._state = _emptyState();
  }

  /** Returns seconds remaining in the active poll (0 if not active). */
  get remainingSecs(): number {
    if (!this._state.active) return 0;
    return Math.max(0, Math.round((this._state.endsAt - Date.now()) / 1000));
  }
}

function _emptyState(): PollState {
  return {
    active: false,
    question: '',
    options: [],
    durationMs: DEFAULT_DURATION_MS,
    startedAt: 0,
    endsAt: 0,
    votedUsers: [],
    winner: null,
  };
}

export const pollManager = new PollManagerService();
