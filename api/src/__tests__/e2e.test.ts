import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";

let db: typeof import("../db.js");
let app: FastifyInstance;
let announce: ((payload: any) => void) | undefined;
let withdraw: ((payload: any) => void) | undefined;
let baseUrl: string;
let ws: WebSocket | undefined;

beforeAll(async () => {
  process.env.DB_PATH = ":memory:";
  process.env.WS_HEARTBEAT_MS = "0";
  db = await import("../db.js");
  db.init();
  db.clearAll();

  const { WebSocket: WSClient } = await import("ws");
  class CompatibleWebSocket extends WSClient {
    private handler?: (event: { data: string }) => void;

    override set onmessage(value: ((event: { data: string }) => void) | null) {
      this.handler = value ?? undefined;
    }

    override get onmessage(): ((event: { data: string }) => void) | null {
      return this.handler ?? null;
    }

    constructor(url: string) {
      super(url);
      this.on("message", (data) => {
        this.handler?.({ data: data.toString() });
      });
    }
  }
  (globalThis as any).WebSocket = CompatibleWebSocket;

  const initialLoad = async () => {
    const ts = Date.now();
    db.upsertPrefix({
      prefix: "10.0.0.0/24",
      origin_as: 64512,
      next_hop: "192.0.2.1",
      as_path: "64512 64513",
      ts,
    });
    db.upsertEdgesFromASPath("64512 64513", ts);
  };

  app = await createApp({
    init: () => db.init(),
    initialRIBLoad: initialLoad,
    getSnapshot: () => db.getSnapshot(),
    startUpdateMonitor: (onAnnounce, onWithdraw) => {
      announce = onAnnounce;
      withdraw = onWithdraw;
      return () => {};
    },
    heartbeatIntervalMs: 0,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("unexpected address type");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  (globalThis as any).__VITE_API_BASE__ = baseUrl;
});

afterAll(async () => {
  ws?.close();
  await app.close();
  db.close();
});

describe("end-to-end", () => {
  it("returns snapshot data and streams live updates", async () => {
    const { fetchSnapshot, connectWS } = await import("../../../web/src/api.ts");

    const snapshot = await fetchSnapshot();
    expect(snapshot).toEqual({
      nodes: [{ asn: 64512 }],
      edges: [{ src_as: 64512, dst_as: 64513 }],
    });

    const messages: any[] = [];
    ws = connectWS((msg) => {
      messages.push(msg);
    });

    await new Promise<void>((resolve) => {
      if (!ws) return resolve();
      (ws as any).on("open", () => resolve());
    });

    announce?.({
      ts: 999,
      prefix: "203.0.113.0/24",
      origin_as: 64513,
      as_path: "64512 64513",
      next_hop: "198.51.100.1",
    });

    await waitForMessages(messages, 1);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "announce",
        prefix: "203.0.113.0/24",
        origin_as: 64513,
      }),
    );

    withdraw?.({ ts: 1000, prefix: "203.0.113.0/24" });
    await waitForMessages(messages, 2);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "withdraw",
        prefix: "203.0.113.0/24",
      }),
    );
  });
});

function waitForMessages(messages: any[], expected: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (messages.length >= expected) {
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}
