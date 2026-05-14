import { opsMemory } from './ops-memory.js';

export interface ModerationFlag {
  user: string;
  text: string;
  reason: string;
  at: number;
}

class ChatOrchestratorService {
  private flags: ModerationFlag[] = [];
  private lastPresenceAt = 0;

  considerFlag(user: string, text: string): string | null {
    const normalized = text.trim();
    if (!normalized) return null;

    if (/https?:\/\//i.test(normalized)) return this._flag(user, text, 'link');
    if (/discord\.gg|t\.me\/|twitch\.tv\//i.test(normalized)) return this._flag(user, text, 'promo');
    if (/(.)\1{10,}/u.test(normalized)) return this._flag(user, text, 'spam-repeat');
    if (/\b(free money|dm me|sub4sub|check my channel)\b/i.test(normalized)) return this._flag(user, text, 'scam/self-promo');
    return null;
  }

  private _flag(user: string, text: string, reason: string): string {
    const flag = { user, text, reason, at: Date.now() };
    this.flags.push(flag);
    if (this.flags.length > 200) this.flags.shift();
    opsMemory.addIncident('chat_flag', `${reason}: ${user}`);
    return reason;
  }

  shouldSendPresence(poolSize: number): boolean {
    const now = Date.now();
    if (poolSize > 0) return false;
    if (now - this.lastPresenceAt < 15 * 60_000) return false;
    this.lastPresenceAt = now;
    return true;
  }

  getStatus() {
    return {
      flags: this.flags.slice(-20),
      flagCount: this.flags.length,
      lastPresenceAt: this.lastPresenceAt,
    };
  }
}

export const chatOrchestrator = new ChatOrchestratorService();
