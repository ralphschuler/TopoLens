import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { getSnapshot, init } from "./db.js";
import {
  initialRIBLoad,
  startUpdateMonitor,
  type AnnounceHandler,
  type WithdrawHandler,
} from "./collector.js";
import type { Heartbeat, LiveAnnounce, LiveMessage, LiveWithdraw } from "./types.js";

export type AppDependencies = {
  init: typeof init;
  initialRIBLoad: typeof initialRIBLoad;
  startUpdateMonitor: typeof startUpdateMonitor;
  getSnapshot: typeof getSnapshot;
  heartbeatIntervalMs: number;
};

const defaultDependencies = (): AppDependencies => ({
  init,
  initialRIBLoad,
  startUpdateMonitor,
  getSnapshot,
  heartbeatIntervalMs: Number.parseInt(process.env.WS_HEARTBEAT_MS ?? "0", 10),
});

type ClientSocket = {
  send: (data: string) => void;
  readyState?: number;
  on: (event: string, listener: (...args: any[]) => void) => void;
};

type Broadcast = (message: LiveMessage) => void;

type AppSetup = {
  app: FastifyInstance;
  broadcast: Broadcast;
};

function setupApp(app: FastifyInstance, deps: AppDependencies): AppSetup {
  const clients = new Set<ClientSocket>();

  app.get("/api/snapshot", async () => deps.getSnapshot());

  app.get("/ws", { websocket: true }, (connection) => {
    const candidate = (connection as any).socket ?? connection;
    if (!candidate || typeof candidate.on !== "function" || typeof candidate.send !== "function") {
      app.log.warn("websocket connection missing socket interface");
      return;
    }
    const socket = candidate as ClientSocket;
    clients.add(socket);
    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  const broadcast: Broadcast = (message) => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      try {
        if (typeof client.readyState === "number" && client.readyState !== 1) {
          continue;
        }
        client.send(payload);
      } catch (error) {
        app.log.warn({ err: error }, "failed to deliver websocket message");
      }
    }
  };

  const onAnnounce: AnnounceHandler = (payload) => {
    const msg: LiveAnnounce = { type: "announce", ...payload };
    broadcast(msg);
  };

  const onWithdraw: WithdrawHandler = (payload) => {
    const msg: LiveWithdraw = { type: "withdraw", ...payload };
    broadcast(msg);
  };

  const stopMonitor = deps.startUpdateMonitor(onAnnounce, onWithdraw);
  app.addHook("onClose", () => {
    try {
      stopMonitor?.();
    } catch (error) {
      app.log.warn({ err: error }, "failed to stop monitor");
    }
  });

  if (deps.heartbeatIntervalMs > 0) {
    const timer = setInterval(() => {
      const msg: Heartbeat = { type: "heartbeat", ts: Date.now() };
      broadcast(msg);
    }, deps.heartbeatIntervalMs);
    timer.unref?.();
    app.addHook("onClose", () => clearInterval(timer));
  }

  return { app, broadcast };
}

export async function createApp(
  overrides: Partial<AppDependencies> = {},
): Promise<FastifyInstance> {
  const deps = { ...defaultDependencies(), ...overrides };

  const app = Fastify({ logger: true });
  await app.register(websocket);

  await deps.init();
  await deps.initialRIBLoad();

  setupApp(app, deps);

  return app;
}
