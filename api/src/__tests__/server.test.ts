import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../app.js";

const noop = () => {};

describe("api server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves snapshots and broadcasts websocket events", async () => {
    const snapshot = {
      nodes: [{ asn: 64512 }],
      edges: [{ src_as: 64512, dst_as: 64513 }],
    };

    let announce: ((payload: any) => void) | undefined;
    let withdraw: ((payload: any) => void) | undefined;
    const stopMonitor = vi.fn();

    const deps: Partial<AppDependencies> = {
      init: noop,
      initialRIBLoad: async () => {},
      getSnapshot: () => snapshot,
      startUpdateMonitor: (onAnnounce, onWithdraw) => {
        announce = onAnnounce;
        withdraw = onWithdraw;
        return stopMonitor;
      },
      heartbeatIntervalMs: 0,
    };

    const app = await createApp(deps);

    const response = await app.inject({ method: "GET", url: "/api/snapshot" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("unexpected address type");
    }
    const port = address.port;

    const { WebSocket: WSClient } = await import("ws");
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
    });

    const nextMessage = () =>
      new Promise<any>((resolve) => {
        const handler = (data: any) => {
          ws.off("message", handler);
          resolve(JSON.parse(data.toString()));
        };
        ws.on("message", handler);
      });

    const announcePromise = nextMessage();
    announce?.({
      ts: 123,
      prefix: "203.0.113.0/24",
      origin_as: 64513,
      as_path: "64512 64513",
      next_hop: "198.51.100.1",
    });

    const message = await announcePromise;
    expect(message).toMatchObject({
      type: "announce",
      prefix: "203.0.113.0/24",
      origin_as: 64513,
    });

    const withdrawPromise = nextMessage();
    withdraw?.({ ts: 456, prefix: "198.51.100.0/24" });
    const withdrawn = await withdrawPromise;
    expect(withdrawn).toMatchObject({
      type: "withdraw",
      prefix: "198.51.100.0/24",
    });

    ws.close();
    await app.close();

    expect(stopMonitor).toHaveBeenCalled();
  });
});
