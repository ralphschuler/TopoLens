import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.env.DB_PATH ?? "./bgp.db";
const db = new DatabaseSync(dbPath);

type PrefixRow = {
  prefix: string;
  origin_as: number | null;
  next_hop?: string | null;
  as_path?: string | null;
  ts: number;
};

type EventRow = {
  ts: number;
  type: string;
  prefix: string;
  origin_as: number | null;
  as_path?: string | null;
  next_hop?: string | null;
};

type EdgeRow = {
  src: number;
  dst: number;
  ts: number;
};

export function init(): void {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  const sql = readFileSync(schemaPath, "utf-8");
  db.exec(sql);
}

export function upsertPrefix(row: PrefixRow): void {
  const stmt = db.prepare(`
    INSERT INTO prefix (prefix, origin_as, next_hop, as_path, last_seen)
    VALUES (@prefix, @origin_as, @next_hop, @as_path, @ts)
    ON CONFLICT(prefix) DO UPDATE SET
      origin_as = excluded.origin_as,
      next_hop = excluded.next_hop,
      as_path = excluded.as_path,
      last_seen = excluded.last_seen;
  `);
  stmt.run({
    ...row,
    next_hop: row.next_hop ?? null,
    as_path: row.as_path ?? null,
  });
}

export function addEvent(row: EventRow): void {
  db.prepare(
    `INSERT INTO events (ts, type, prefix, origin_as, as_path, next_hop)
     VALUES (@ts, @type, @prefix, @origin_as, @as_path, @next_hop)`,
  ).run(row);
}

export function upsertEdgesFromASPath(asPath: string | undefined, ts: number): void {
  if (!asPath) return;
  const parts = asPath
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));

  for (let i = 0; i < parts.length - 1; i += 1) {
    const edge: EdgeRow = { src: parts[i], dst: parts[i + 1], ts };
    db.prepare(
      `INSERT INTO as_edge (src_as, dst_as, last_seen)
       VALUES (@src, @dst, @ts)
       ON CONFLICT(src_as, dst_as) DO UPDATE SET last_seen = excluded.last_seen;`,
    ).run(edge);
  }
}

export function getSnapshot(): {
  nodes: Array<{ asn: number }>;
  edges: Array<{ src_as: number; dst_as: number }>;
} {
  const nodes = db
    .prepare(`SELECT DISTINCT origin_as AS asn FROM prefix WHERE origin_as IS NOT NULL`)
    .all();
  const edges = db.prepare(`SELECT src_as, dst_as FROM as_edge`).all();
  return { nodes, edges };
}

export function clearAll(): void {
  db.exec(`
    DELETE FROM prefix;
    DELETE FROM as_edge;
    DELETE FROM events;
  `);
}

export function close(): void {
  db.close();
}
