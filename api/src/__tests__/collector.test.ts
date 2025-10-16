import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type DbModule = typeof import("../db.js");
type CollectorModule = typeof import("../collector.js");

let db: DbModule;
let collector: CollectorModule;
let stopSpy: (() => void) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DB_PATH = ":memory:";
  process.env.DEMO_MODE = "false";

  db = await import("../db.js");
  db.init();
  db.clearAll();

  collector = await import("../collector.js");
  stopSpy = undefined;
});

afterEach(() => {
  db.close();
  stopSpy?.();
});

describe("collector", () => {
  it("ingests initial RIB data", async () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();

    const killMock = vi.fn();
    spawnMock.mockReturnValueOnce({
      stdout,
      on: emitter.on.bind(emitter),
      kill: killMock,
    } as any);

    const ribEntries = [
      {
        prefix: "203.0.113.0/24",
        paths: [
          {
            attrs: [
              { type: "AS_PATH", value: [[65001, 65002]] },
              { type: "NEXT_HOP", nexthop: "198.51.100.1" },
            ],
            nexthop: "198.51.100.254",
          },
        ],
      },
    ];

    const loadPromise = collector.initialRIBLoad();
    stdout.emit("data", Buffer.from(JSON.stringify(ribEntries)));
    emitter.emit("close");

    await loadPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "gobgp",
      ["-j", "global", "rib"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "inherit"] }),
    );

    const snapshot = db.getSnapshot();
    expect(snapshot.nodes).toEqual([{ asn: 65002 }]);
    expect(snapshot.edges).toEqual([{ src_as: 65001, dst_as: 65002 }]);
  });

  it("emits announce and withdraw events for updates", async () => {
    const emitter = new EventEmitter();
    const stdout = new PassThrough();

    const killMock = vi.fn();
    spawnMock.mockReturnValueOnce({
      stdout,
      on: emitter.on.bind(emitter),
      kill: killMock,
    } as any);

    const announce = vi.fn();
    const withdraw = vi.fn();

    const stopper = collector.startUpdateMonitor(announce, withdraw);
    stopSpy = stopper;

    const message = {
      announced: [
        {
          nlri: { prefix: "203.0.113.0/24" },
          attrs: [
            { type: "AS_PATH", value: [[65001, 65002, 65003]] },
            { type: "NEXT_HOP", nexthop: "198.51.100.2" },
          ],
        },
      ],
      withdrawn: [{ prefix: "198.51.100.0/24" }],
    };

    stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spawnMock).toHaveBeenCalledWith(
      "gobgp",
      ["monitor", "global", "updates", "-j"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "inherit"] }),
    );

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toMatchObject({
      prefix: "203.0.113.0/24",
      origin_as: 65003,
      as_path: "65001 65002 65003",
      next_hop: "198.51.100.2",
    });

    expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ prefix: "198.51.100.0/24" }));

    const snapshot = db.getSnapshot();
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { src_as: 65001, dst_as: 65002 },
        { src_as: 65002, dst_as: 65003 },
      ]),
    );

    stopper();
    expect(killMock).toHaveBeenCalled();
    stopSpy = undefined;
  });
});
