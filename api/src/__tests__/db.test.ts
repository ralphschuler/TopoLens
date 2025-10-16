import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type DbModule = typeof import("../db.js");

let db: DbModule;

beforeAll(async () => {
  process.env.DB_PATH = ":memory:";
  db = await import("../db.js");
  db.init();
});

beforeEach(() => {
  db.clearAll();
});

afterAll(() => {
  db.close();
});

describe("database helpers", () => {
  it("persists prefixes and derived edges", () => {
    const ts = Date.now();
    db.upsertPrefix({
      prefix: "10.0.0.0/24",
      origin_as: 65000,
      next_hop: "192.0.2.1",
      as_path: "65000 65100",
      ts,
    });
    db.upsertEdgesFromASPath("65000 65100 65200", ts);

    const snapshot = db.getSnapshot();
    expect(snapshot.nodes).toEqual([{ asn: 65000 }]);
    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        { src_as: 65000, dst_as: 65100 },
        { src_as: 65100, dst_as: 65200 },
      ]),
    );
    expect(snapshot.edges).toHaveLength(2);
  });

  it("deduplicates edges when reprocessing the same path", () => {
    const ts = Date.now();
    db.upsertEdgesFromASPath("65000 65001", ts);
    db.upsertEdgesFromASPath("65000 65001", ts + 1000);

    const snapshot = db.getSnapshot();
    expect(snapshot.edges).toEqual([{ src_as: 65000, dst_as: 65001 }]);
  });

  it("clears all data via clearAll", () => {
    const ts = Date.now();
    db.upsertPrefix({
      prefix: "192.0.2.0/24",
      origin_as: 64512,
      next_hop: null,
      as_path: undefined,
      ts,
    });
    db.upsertEdgesFromASPath("64512 64513", ts);

    db.clearAll();
    const snapshot = db.getSnapshot();
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.edges).toEqual([]);
  });
});
