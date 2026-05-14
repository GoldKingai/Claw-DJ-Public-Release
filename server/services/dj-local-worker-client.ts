import net from "node:net";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerCommandType,
  WorkerPlayRequest,
} from "./dj-local-worker-protocol.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.DJ_LOCAL_WORKER_PORT || 3011);
const TIMEOUT_MS = 5000;

let _requestCounter = 0;
function nextRequestId(): string {
  return `req_${Date.now()}_${++_requestCounter}`;
}

function send(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`worker request timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    socket.once("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        clearTimeout(timer);
        socket.destroy();
        try {
          resolve(JSON.parse(buffer.slice(0, newlineIdx)) as WorkerResponse);
        } catch (err) {
          reject(new Error(`failed to parse worker response: ${err}`));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

type PlayMeta = Partial<Pick<WorkerPlayRequest, "trackId" | "title" | "artist" | "duration">>;

export const djLocalWorkerClient = {
  ping: () =>
    send({ requestId: nextRequestId(), type: "ping" }),

  status: () =>
    send({ requestId: nextRequestId(), type: "status" }),

  play: (uri: string, meta?: PlayMeta) =>
    send({
      requestId: nextRequestId(),
      type: "play",
      uri,
      playbackToken: `play_${Date.now()}`,
      ...meta,
    } as WorkerPlayRequest),

  pause: () =>
    send({ requestId: nextRequestId(), type: "pause" }),

  resume: () =>
    send({ requestId: nextRequestId(), type: "resume" }),

  stop: () =>
    send({ requestId: nextRequestId(), type: "stop" }),

  seek: (positionSeconds: number) =>
    send({ requestId: nextRequestId(), type: "seek", positionSeconds }),

  setVolume: (volume: number) =>
    send({ requestId: nextRequestId(), type: "set-volume", volume }),

  preload: (uri: string, meta?: PlayMeta) =>
    send({
      requestId: nextRequestId(),
      type: "preload",
      uri,
      playbackToken: `preload_${Date.now()}`,
      ...meta,
    } as any),

  crossfade: (durationSeconds: number = 6) =>
    send({ requestId: nextRequestId(), type: "crossfade", durationSeconds } as any),
};

export type { WorkerResponse, WorkerState, WorkerCommandType } from "./dj-local-worker-protocol.js";
