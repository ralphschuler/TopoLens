import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteTrackerSnapshot, TopologyChange } from "./topology/routeTracker";
import type { GraphPayload } from "./workers/messages";

const mocks = vi.hoisted(() => ({
  useGraphData: vi.fn(),
  useRipeRis: vi.fn(),
}));

vi.mock("./hooks/useGraphData", () => ({
  useGraphData: mocks.useGraphData,
}));

vi.mock("./hooks/useRipeRis", () => ({
  useRipeRis: mocks.useRipeRis,
}));

vi.mock("./components/SigmaGraph", () => ({
  default: () => <div data-testid="sigma-graph" />,
}));

const EMPTY_GRAPH: GraphPayload = {
  nodes: [],
  links: [],
  meta: {
    truncated: false,
    selectedChangeSequence: null,
    routes: { included: 0, total: 0 },
    nodes: { included: 0, total: 0 },
    links: { included: 0, total: 0 },
  },
};

const EMPTY_STATS: RouteTrackerSnapshot["stats"] = {
  updatesReceived: 1,
  announcementsReceived: 1,
  withdrawalsReceived: 0,
  identicalAnnouncementsIgnored: 0,
  nonTopologyAnnouncements: 0,
  firstObservedChanges: 0,
  pathChangedChanges: 1,
  originChangedChanges: 0,
  withdrawnChanges: 0,
  withdrawalObservedChanges: 0,
  changesObserved: 1,
  trackedRoutes: 0,
  evictedRoutes: 0,
  retainedChanges: 1,
  droppedChanges: 0,
};

function makeChange(timestamp: number): TopologyChange {
  return {
    sequence: 7,
    type: "path-changed",
    routeKey: '["rrc00","192.0.2.1","203.0.113.0/24"]',
    messageId: "ris-message-7",
    timestamp,
    receivedAt: timestamp + 25,
    collector: "rrc00",
    peer: "192.0.2.1",
    prefix: "203.0.113.0/24",
    previousPath: [
      { kind: "asn", asn: 64500 },
      { kind: "asn", asn: 64496 },
    ],
    previousPathDisplay: "64500 64496",
    currentPath: [
      { kind: "asn", asn: 64500 },
      { kind: "asn", asn: 64501 },
      { kind: "asn", asn: 64496 },
    ],
    currentPathDisplay: "64500 64501 64496",
    previousOrigin: { kind: "asn", asn: 64496 },
    currentOrigin: { kind: "asn", asn: 64496 },
    addedEdges: [
      { key: "64500--64501", source: 64500, target: 64501 },
      { key: "64496--64501", source: 64496, target: 64501 },
    ],
    removedEdges: [{ key: "64496--64500", source: 64496, target: 64500 }],
  };
}

interface MountedApp {
  container: HTMLDivElement;
  root: Root;
}

const mountedApps: MountedApp[] = [];
let animationFrames: FrameRequestCallback[];
let clearSession: ReturnType<typeof vi.fn>;

function buttonNamed(name: string | RegExp): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    const accessibleName = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string" ? accessibleName.trim() === name : name.test(accessibleName);
  });
  if (!button) throw new Error(`Could not find button named ${String(name)}`);
  return button;
}

function regionNamed(name: string): HTMLElement {
  const region = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  if (!region) throw new Error(`Could not find region named ${name}`);
  return region;
}

async function renderApp(): Promise<void> {
  const { default: App } = await import("./App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedApps.push({ container, root });

  await act(async () => {
    root.render(<App />);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  animationFrames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });

  clearSession = vi.fn();
  const now = Date.now();
  const change = makeChange(now - 1_000);

  mocks.useRipeRis.mockReturnValue({
    snapshot: {
      routes: [],
      changes: [change],
      stats: EMPTY_STATS,
    },
    status: "connected",
    workerStatus: "connected",
    subscription: { collector: "rrc00", prefix: "", path: "" },
    sessionStartedAt: now - 60_000,
    lastUpdateAt: now - 1_000,
    error: null,
    gaps: [],
    isPaused: false,
    pendingUpdateCount: 0,
    droppedPausedUpdates: 0,
    retryInMs: null,
    pause: vi.fn(),
    resume: vi.fn(),
    reconnect: vi.fn(),
    clearSession,
    configure: vi.fn(),
  });
  mocks.useGraphData.mockReturnValue({
    graph: EMPTY_GRAPH,
    isComputing: false,
    error: null,
  });
});

afterEach(async () => {
  while (mountedApps.length > 0) {
    const mounted = mountedApps.pop();
    if (!mounted) continue;
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TopoLens mobile accessibility flows", () => {
  it("switches between the mobile Map and Changes views", async () => {
    await renderApp();

    const mapTab = buttonNamed("Map");
    const changesTab = buttonNamed(/Changes/);
    const map = regionNamed("Autonomous system topology map");
    const changes = regionNamed("Topology change stream");

    expect(mapTab.getAttribute("aria-current")).toBe("page");
    expect(changesTab.hasAttribute("aria-current")).toBe(false);
    expect(map.classList.contains("hidden")).toBe(false);
    expect(changes.classList.contains("hidden")).toBe(true);

    await act(async () => changesTab.click());

    expect(mapTab.hasAttribute("aria-current")).toBe(false);
    expect(changesTab.getAttribute("aria-current")).toBe("page");
    expect(map.classList.contains("hidden")).toBe(true);
    expect(changes.classList.contains("hidden")).toBe(false);

    await act(async () => mapTab.click());

    expect(mapTab.getAttribute("aria-current")).toBe("page");
    expect(map.classList.contains("hidden")).toBe(false);
    expect(changes.classList.contains("hidden")).toBe(true);
  });

  it("clears the local session from the mobile reset action", async () => {
    await renderApp();

    await act(async () => buttonNamed("Clear local session state").click());

    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("focuses the inspector close action and restores focus to the remounted event", async () => {
    await renderApp();
    await act(async () => buttonNamed(/Changes/).click());

    const event = document.getElementById("topology-change-7") as HTMLButtonElement | null;
    expect(event).not.toBeNull();
    event?.focus();
    expect(document.activeElement).toBe(event);

    await act(async () => event?.click());

    const close = buttonNamed("Close change inspector");
    expect(document.activeElement).toBe(close);
    expect(document.getElementById("topology-change-7")).toBeNull();

    await act(async () => close.click());
    expect(animationFrames).toHaveLength(1);

    await act(async () => {
      const callbacks = animationFrames.splice(0);
      callbacks.forEach((callback) => callback(performance.now()));
    });

    const remountedEvent = document.getElementById("topology-change-7");
    expect(remountedEvent).not.toBe(event);
    expect(document.activeElement).toBe(remountedEvent);
  });
});
