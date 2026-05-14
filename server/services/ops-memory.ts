import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, '../data/ops-memory.json');

export interface ViewerMemory {
  name: string;
  lastSeenAt: number;
  lastMessageAt: number;
  messages: number;
}

export interface OpsMemoryShape {
  viewers: Record<string, ViewerMemory>;
  recentRequests: Array<{ user: string; text: string; at: number }>;
  incidents: Array<{ type: string; detail: string; at: number }>;
}

class OpsMemoryService {
  private data: OpsMemoryShape = {
    viewers: {},
    recentRequests: [],
    incidents: [],
  };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        this.data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')) as OpsMemoryShape;
      }
    } catch (err) {
      console.warn('[OpsMemory] Could not load memory file:', err);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[OpsMemory] Could not save memory file:', err);
    }
  }

  noteViewer(user: string): void {
    const now = Date.now();
    const key = user.trim().toLowerCase();
    if (!key) return;

    const prev = this.data.viewers[key];
    this.data.viewers[key] = {
      name: user,
      lastSeenAt: now,
      lastMessageAt: now,
      messages: (prev?.messages ?? 0) + 1,
    };
    this.save();
  }

  addRequest(user: string, text: string): void {
    this.data.recentRequests.push({ user, text, at: Date.now() });
    if (this.data.recentRequests.length > 200) this.data.recentRequests.shift();
    this.save();
  }

  addIncident(type: string, detail: string): void {
    this.data.incidents.push({ type, detail, at: Date.now() });
    if (this.data.incidents.length > 200) this.data.incidents.shift();
    this.save();
  }

  snapshot(): OpsMemoryShape {
    return JSON.parse(JSON.stringify(this.data)) as OpsMemoryShape;
  }
}

export const opsMemory = new OpsMemoryService();
