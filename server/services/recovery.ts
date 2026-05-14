/**
 * Recovery / self-healing routes.
 *
 * Gives the local operator and automation a single place to perform safe
 * corrective actions without needing to remember low-level service commands.
 */

import { Router, type Request, type Response } from 'express';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { obsController } from '../services/obs-controller.js';
import { youtubeStreamDetector } from '../services/youtube-stream-detector.js';
import { youtubeMetricsService } from '../services/youtube-metrics.js';
import { youtubeChatService } from '../services/youtube-chat.js';
import { opsMemory } from '../services/ops-memory.js';

const exec = promisify(execCb);
const router = Router();

const MAX_OUTPUT = 4_000;

async function run(command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(command, { timeout: 30_000 });
    return { ok: true, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').slice(0, MAX_OUTPUT),
      stderr: (e.stderr ?? e.message ?? String(err)).slice(0, MAX_OUTPUT),
    };
  }
}

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    obsConnected: obsController.isConnected,
    detectorConfigured: youtubeStreamDetector.isConfigured,
    metricsConfigured: youtubeMetricsService.isConfigured,
    chatConfigured: youtubeChatService.isConfigured,
    recentIncidents: opsMemory.snapshot().incidents.slice(-10),
  });
});

router.post('/obs-reconnect', async (_req: Request, res: Response) => {
  try {
    await obsController.disconnect().catch(() => {});
    await obsController.connect();
    opsMemory.addIncident('recovery_action', 'obs reconnect');
    res.json({ ok: true, connected: true });
  } catch (err) {
    opsMemory.addIncident('recovery_failure', `obs reconnect: ${String(err)}`);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/browser-source/list', async (_req: Request, res: Response) => {
  if (!obsController.isConnected) {
    res.status(503).json({ error: 'OBS not connected' });
    return;
  }
  try {
    const inputs = await obsController.listInputs();
    const browserSources = inputs.filter((i) => i.inputKind === 'browser_source');
    res.json({ inputs, browserSources });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/browser-source/refresh', async (req: Request, res: Response) => {
  if (!obsController.isConnected) {
    res.status(503).json({ error: 'OBS not connected' });
    return;
  }
  try {
    const inputName = String((req.body as Record<string, unknown>)?.inputName ?? '');
    let refreshed: string[];
    if (inputName) {
      await obsController.refreshBrowserSource(inputName);
      refreshed = [inputName];
    } else {
      refreshed = await obsController.refreshAllBrowserSources();
    }
    opsMemory.addIncident('recovery_action', `browser source refresh: ${refreshed.join(', ')}`);
    res.json({ ok: true, refreshed });
  } catch (err) {
    opsMemory.addIncident('recovery_failure', `browser source refresh: ${String(err)}`);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/service/:name/restart', async (req: Request, res: Response) => {
  const name = String(req.params['name'] ?? '');
  const allowed = new Set(['claw-dj', 'luxtts']);

  if (!name || !allowed.has(name)) {
    res.status(400).json({ error: 'allowed services: claw-dj, luxtts' });
    return;
  }

  const result = await run(`sudo systemctl restart ${name}`);
  opsMemory.addIncident(result.ok ? 'recovery_action' : 'recovery_failure', `restart ${name}`);

  if (!result.ok) {
    res.status(500).json(result);
    return;
  }

  res.json(result);
});

export default router;
