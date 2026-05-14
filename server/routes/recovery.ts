/**
 * Recovery / self-healing routes.
 *
 * Gives the local operator and automation a single place to perform safe
 * corrective actions without needing to remember low-level service commands.
 */

import { safeErrorMessage } from '../utils/error-response.js';
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
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/browser-source/create-deck', async (_req: Request, res: Response) => {
  if (!obsController.isConnected) {
    res.status(503).json({ error: 'OBS not connected' });
    return;
  }
  try {
    const scenes = await obsController.listScenes();
    const sceneName = scenes[0] ?? 'Scene';
    const inputName = 'FlowDJ Audio Deck';
    const url = 'http://localhost:3001/obs-deck';
    const created = await obsController.ensureBrowserSource(inputName, url, sceneName);
    if (!created) {
      // Already exists — just refresh it
      await obsController.refreshBrowserSource(inputName);
    }
    // Ensure the browser source is unmuted — it IS the audio path into OBS.
    await obsController.setInputMuted(inputName, false);
    opsMemory.addIncident('recovery_action', `deck browser source ${created ? 'created' : 'refreshed'}: ${inputName}`);
    res.json({ ok: true, created, inputName, sceneName });
  } catch (err) {
    opsMemory.addIncident('recovery_failure', `deck browser source: ${String(err)}`);
    res.status(500).json({ error: safeErrorMessage(err) });
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
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/browser-source/remove', async (req: Request, res: Response) => {
  if (!obsController.isConnected) {
    res.status(503).json({ error: 'OBS not connected' });
    return;
  }
  try {
    const inputName = String((req.body as Record<string, unknown>)?.inputName ?? '');
    if (!inputName) {
      res.status(400).json({ error: 'inputName required' });
      return;
    }
    await obsController.removeInput(inputName);
    opsMemory.addIncident('recovery_action', `removed input: ${inputName}`);
    res.json({ ok: true, removed: inputName });
  } catch (err) {
    opsMemory.addIncident('recovery_failure', `remove input: ${String(err)}`);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

/**
 * Disable the pw-loopback audio sink service.
 * This service creates a duplicate dj-audio sink whose output side follows the
 * system default device (HDMI). When HDMI is unplugged PipeWire reconfigures
 * the loopback node causing muffled/disrupted audio. The null-sink service
 * (dj-audio-sinks.service) is the correct one; the loopback is not needed.
 */
router.post('/audio/disable-loopback', async (_req: Request, res: Response) => {
  // User-level service (not system) — must use `systemctl --user`, not sudo
  const stop    = await run('XDG_RUNTIME_DIR=/run/user/1000 systemctl --user stop dj-audio-loopback.service');
  const disable = await run('XDG_RUNTIME_DIR=/run/user/1000 systemctl --user disable dj-audio-loopback.service');
  const ok = disable.ok || stop.stderr.includes('not loaded'); // already disabled = fine
  opsMemory.addIncident(
    ok ? 'recovery_action' : 'recovery_failure',
    `disable dj-audio-loopback: stop.ok=${stop.ok} disable.ok=${disable.ok}`,
  );
  res.status(ok ? 200 : 500).json({ ok, stop, disable });
});

router.post('/service/:name/restart', async (req: Request, res: Response) => {
  const name = String(req.params['name'] ?? '');
  const allowed = new Set(['flowdj', 'luxtts']);

  if (!name || !allowed.has(name)) {
    res.status(400).json({ error: 'allowed services: flowdj, luxtts' });
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
