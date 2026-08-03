import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchWorkerCommand, FetchWorkerEvent } from "./messages";

interface FakeWorkerContext {
  onmessage: ((event: MessageEvent<FetchWorkerCommand>) => void) | null;
  postMessage: ReturnType<typeof vi.fn<(event: FetchWorkerEvent) => void>>;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly send = vi.fn<(payload: string) => void>();
  readonly close = vi.fn<() => void>();
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(payload: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

function risMessage(prefix: string, id: string) {
  return {
    type: "ris_message",
    data: {
      timestamp: 1_700_000_000,
      peer: "192.0.2.1",
      peer_asn: "65000",
      id,
      host: "rrc00",
      type: "UPDATE",
      path: [65000, 64496],
      announcements: [{ next_hop: "192.0.2.254", prefixes: [prefix] }],
    },
  };
}

const subscription = { collector: "rrc00", prefix: "", path: "" };

async function loadWorker() {
  const events: FetchWorkerEvent[] = [];
  const context: FakeWorkerContext = {
    onmessage: null,
    postMessage: vi.fn((event: FetchWorkerEvent) => {
      events.push(event);
    }),
  };
  vi.stubGlobal("self", context);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  await import("./fetchWorker");

  const command = (data: FetchWorkerCommand) => {
    if (!context.onmessage) throw new Error("Worker command handler was not installed");
    context.onmessage({ data } as MessageEvent<FetchWorkerCommand>);
  };
  return { context, events, command };
}

describe("fetchWorker generations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tags every event and confirms a subscription only once per connection", async () => {
    const { events, command } = await loadWorker();
    command({ type: "start", subscription, generation: 4 } as FetchWorkerCommand);

    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ type: "ris_subscribe_ok", data: {} });
    socket.message(risMessage("203.0.113.0/24", "message-1"));
    socket.message(risMessage("198.51.100.0/24", "message-2"));
    vi.advanceTimersByTime(200);

    expect(events.every((event) => event.generation === 4)).toBe(true);
    expect(
      events.filter((event) => event.type === "status" && event.status === "connected"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "updates")).toEqual([
      expect.objectContaining({
        type: "updates",
        generation: 4,
        updates: [
          expect.objectContaining({ prefix: "203.0.113.0/24" }),
          expect.objectContaining({ prefix: "198.51.100.0/24" }),
        ],
      }),
    ]);
  });

  it("atomically discards the old batch and silences stale socket callbacks on configure", async () => {
    const { events, command } = await loadWorker();
    command({ type: "start", subscription, generation: 1 } as FetchWorkerCommand);

    const oldSocket = FakeWebSocket.instances[0];
    oldSocket.open();
    oldSocket.message(risMessage("203.0.113.0/24", "old-buffered"));
    const staleOpen = oldSocket.onopen;
    const staleMessage = oldSocket.onmessage;
    const staleError = oldSocket.onerror;
    const staleClose = oldSocket.onclose;

    command({
      type: "configure",
      subscription: { collector: "rrc21", prefix: "198.51.100.0/24", path: "" },
      generation: 2,
    } as FetchWorkerCommand);

    const newSocket = FakeWebSocket.instances[1];
    staleOpen?.(new Event("open"));
    staleMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(risMessage("192.0.2.0/24", "stale-callback")),
      }),
    );
    staleError?.(new Event("error"));
    staleClose?.(new CloseEvent("close", { reason: "stale close" }));
    vi.advanceTimersByTime(200);

    expect(newSocket.close).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "updates")).toEqual([]);
    const generationTwoStart = events.findIndex(
      (event) => event.type === "status" && event.status === "connecting" && event.generation === 2,
    );
    expect(generationTwoStart).toBeGreaterThanOrEqual(0);
    expect(events.slice(generationTwoStart).every((event) => event.generation === 2)).toBe(true);

    newSocket.open();
    newSocket.message(risMessage("198.51.100.0/24", "new-generation"));
    vi.advanceTimersByTime(200);

    expect(events.filter((event) => event.type === "updates")).toEqual([
      expect.objectContaining({
        type: "updates",
        generation: 2,
        updates: [expect.objectContaining({ id: "new-generation" })],
      }),
    ]);
  });

  it("keeps manual reconnects inside the active generation", async () => {
    const { events, command } = await loadWorker();
    command({ type: "start", subscription, generation: 9 } as FetchWorkerCommand);
    command({ type: "reconnect" });

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(events.every((event) => event.generation === 9)).toBe(true);
  });
});
