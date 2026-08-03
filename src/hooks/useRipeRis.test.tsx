import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RipeUpdate } from "../utils/ris";
import type { FetchWorkerCommand, FetchWorkerEvent } from "../workers/messages";
import { useRipeRis } from "./useRipeRis";

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly commands: FetchWorkerCommand[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(command: FetchWorkerCommand): void {
    this.commands.push(command);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {}

  emit(message: FetchWorkerEvent): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}

type HookResult = ReturnType<typeof useRipeRis>;

function update(id: string): RipeUpdate {
  return {
    kind: "announce",
    timestamp: 1_000,
    receivedAt: 1_010,
    id,
    prefix: "203.0.113.0/24",
    peer: "192.0.2.1",
    collector: "rrc00",
    host: "rrc00",
    peerAsn: 65000,
    originAs: 64496,
    origin: { kind: "asn", asn: 64496 },
    nextHop: "192.0.2.254",
    asPath: [
      { kind: "asn", asn: 65000 },
      { kind: "asn", asn: 64496 },
    ],
    asPathDisplay: "65000 64496",
  };
}

async function renderHook() {
  let current: HookResult | null = null;
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);

  function Harness() {
    const value = useRipeRis();
    useEffect(() => {
      current = value;
    });
    return null;
  }

  await act(async () => {
    root.render(<Harness />);
  });

  return {
    get current(): HookResult {
      if (!current) throw new Error("Hook did not render");
      return current;
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("useRipeRis generation boundaries", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("increments generation on configure and ignores every stale worker event", async () => {
    const hook = await renderHook();
    const worker = FakeWorker.instances[0];
    expect(worker.commands[0]).toMatchObject({ type: "start", generation: 1 });

    await act(async () => {
      worker.emit({ type: "status", status: "connected", generation: 1 } as FetchWorkerEvent);
      hook.current.configure({ collector: "rrc21", prefix: "203.0.113.0/24", path: "" });
    });
    expect(worker.commands.at(-1)).toMatchObject({
      type: "configure",
      generation: 2,
      subscription: { collector: "rrc21", prefix: "203.0.113.0/24", path: "" },
    });

    await act(async () => {
      worker.emit({
        type: "error",
        error: "old generation failed",
        fatal: true,
        generation: 1,
      } as FetchWorkerEvent);
      worker.emit({ type: "closed", at: 2_000, generation: 1 } as FetchWorkerEvent);
      worker.emit({
        type: "updates",
        updates: [update("stale")],
        generation: 1,
      } as FetchWorkerEvent);
    });
    expect(hook.current).toMatchObject({
      workerStatus: "connecting",
      error: null,
      gaps: [],
      lastUpdateAt: null,
    });

    await act(async () => {
      worker.emit({ type: "status", status: "connected", generation: 2 } as FetchWorkerEvent);
    });
    expect(hook.current.workerStatus).toBe("connected");

    await hook.unmount();
  });

  it("clearSession resets local pause/gap state without changing the connection generation", async () => {
    const hook = await renderHook();
    const worker = FakeWorker.instances[0];

    await act(async () => {
      worker.emit({ type: "status", status: "connected", generation: 1 } as FetchWorkerEvent);
      worker.emit({
        type: "closed",
        at: 1_500,
        reason: "network",
        generation: 1,
      } as FetchWorkerEvent);
      hook.current.pause();
      worker.emit({
        type: "updates",
        updates: [update("paused")],
        generation: 1,
      } as FetchWorkerEvent);
    });
    expect(hook.current).toMatchObject({
      workerStatus: "connected",
      isPaused: true,
      pendingUpdateCount: 1,
      lastUpdateAt: 1_010,
    });
    expect(hook.current.gaps).toHaveLength(1);

    const commandCount = worker.commands.length;
    await act(async () => {
      hook.current.resume();
      hook.current.clearSession();
    });
    expect(worker.commands).toHaveLength(commandCount);
    expect(hook.current).toMatchObject({
      workerStatus: "connected",
      isPaused: false,
      pendingUpdateCount: 0,
      droppedPausedUpdates: 0,
      lastUpdateAt: null,
      gaps: [],
    });

    await act(async () => {
      hook.current.configure({ collector: "rrc01", prefix: "", path: "" });
    });
    expect(worker.commands.at(-1)).toMatchObject({ type: "configure", generation: 2 });

    await hook.unmount();
  });

  it("keeps reconnect in the current generation", async () => {
    const hook = await renderHook();
    const worker = FakeWorker.instances[0];

    await act(async () => hook.current.reconnect());
    expect(worker.commands.at(-1)).toEqual({ type: "reconnect" });

    await act(async () => {
      hook.current.configure({ collector: "rrc01", prefix: "", path: "" });
    });
    expect(worker.commands.at(-1)).toMatchObject({ type: "configure", generation: 2 });

    await hook.unmount();
  });

  it("keeps an error state when reconnect or configure has no live worker", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("worker construction failed");
        }
      },
    );
    const hook = await renderHook();

    await act(async () => Promise.resolve());
    expect(hook.current.workerStatus).toBe("error");
    const originalSubscription = hook.current.subscription;

    await act(async () => {
      hook.current.reconnect();
      hook.current.configure({ collector: "rrc21", prefix: "203.0.113.0/24", path: "" });
    });

    expect(hook.current.workerStatus).toBe("error");
    expect(hook.current.error).toMatch(/worker is unavailable/i);
    expect(hook.current.subscription).toEqual(originalSubscription);

    await hook.unmount();
  });
});
