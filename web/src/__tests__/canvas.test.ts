import { beforeAll, describe, expect, it, vi } from "vitest";
import { CanvasGraph } from "../canvas";

type Context2D = CanvasRenderingContext2D & {
  calls: Array<{ method: string; args: unknown[] }>;
};

beforeAll(() => {
  class StubResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const rect = target.getBoundingClientRect();
      this.cb(
        [
          {
            target,
            contentRect: rect,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as ResizeObserverEntry,
        ],
        this,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as any).ResizeObserver = StubResizeObserver;

  const context: Partial<Context2D> = {
    calls: [],
    clearRect: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    restore: vi.fn(),
  };

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    value: vi.fn(() => context as CanvasRenderingContext2D),
    configurable: true,
  });
  (globalThis as any).requestAnimationFrame = () => 1;
});

describe("CanvasGraph", () => {
  it("loads snapshots and applies announcements", () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    container.getBoundingClientRect = () => ({
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      toJSON() {
        return {};
      },
    });
    document.body.appendChild(container);

    const graph = new CanvasGraph(container);
    graph.setSnapshot([{ asn: 64512 }], [{ src_as: 64512, dst_as: 64513 }]);

    const nodes = (graph as any).nodes as Map<number, any>;
    const edges = (graph as any).edges as Array<{ s: number; d: number }>;

    expect(nodes.has(64512)).toBe(true);
    expect(edges).toContainEqual({ s: 64512, d: 64513 });

    graph.applyAnnounce(64513, "64513 64514 64515");

    expect(nodes.has(64514)).toBe(true);
    expect(nodes.has(64515)).toBe(true);
    expect(edges).toContainEqual({ s: 64514, d: 64515 });
  });
});
