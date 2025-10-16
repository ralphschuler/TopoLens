# TopoLens

## Overview

TopoLens is a self-contained BGP visualization stack designed for lab and on-call scenarios where you want to see the state of your network at a glance without relying on third-party services. The project combines a GoBGP collector, a Node.js API, a Vite-powered frontend, and SQLite persistence, all orchestrated with Docker Compose. A demo mode is available for development or late-night troubleshooting when no live BGP peer is reachable.

## Target Architecture

```
┌──────────────┐   TCP/179   ┌──────────────┐     JSON (RIB+Updates)     ┌──────────────┐     WS/SSE     ┌───────────────┐
│    Router    ├────────────►│    gobgpd    │────────────────────────────►│     API      ├───────────────►│   Web (Vite)  │
│  (BGP Peer)  │             │ (Collector)  │                             │(Fastify+SQL) │               │   Canvas UI   │
└──────────────┘             └──────────────┘                             └──────────────┘               └───────────────┘
                                                SQLite (cache/history)
```

* **Collector/Peer**: `gobgpd` peers with your router.
* **API**: A Fastify server (with WebSocket support) consumes GoBGP JSON for RIB dumps and update streams, storing results in SQLite.
* **Frontend**: A Vite + TypeScript application renders the AS-level topology in a `<canvas>` element with pan and zoom, consuming data via WebSocket/SSE.
* **Docker Compose**: A single `docker compose up --build` brings the entire stack online.

### Data Flow

1. **RIB initialization**: The API triggers `gobgp -j global rib` on startup (or periodically) and persists the snapshot to SQLite.
2. **Live updates**: `gobgp monitor global updates -j` streams announcements and withdrawals. The API writes each event to SQLite and broadcasts to WebSocket clients.
3. **Frontend consumption**: The web app fetches an initial snapshot over REST, then listens for live deltas over WebSocket.
4. **Canvas rendering**: A lightweight force-directed layout animates nodes and edges with pan/zoom controls and filtering hooks.

## Repository Layout

```
TopoLens/
├─ docker-compose.yml
├─ .env.example
├─ gobgp/
│  └─ gobgpd.conf
├─ api/
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ eslint.config.mjs
│  ├─ vitest.config.ts
│  ├─ vite.config.ts
│  ├─ Dockerfile
│  └─ src/
│     ├─ index.ts           # Server entry point
│     ├─ app.ts             # Fastify app setup & WebSocket
│     ├─ db.ts              # SQLite bootstrap & queries
│     ├─ collector.ts       # RIB + update reader (spawns gobgp)
│     ├─ schema.sql
│     ├─ types.ts
│     └─ __tests__/         # Vitest unit tests
└─ web/
   ├─ index.html
   ├─ package.json
   ├─ tsconfig.json
   ├─ eslint.config.mjs
   ├─ vitest.config.ts
   ├─ vite.config.ts
   ├─ Dockerfile
   └─ src/
      ├─ main.ts
      ├─ canvas.ts          # Rendering, pan/zoom, layout
      ├─ api.ts             # REST/WS client helpers
      └─ __tests__/         # Vitest unit tests
```

## Docker Compose

```yaml
version: "3.8"

services:
  gobgp:
    image: osrg/gobgp:latest
    container_name: gobgp
    network_mode: host   # host mode simplifies peering; alternatively use bridge + port mapping
    volumes:
      - ./gobgp/gobgpd.conf:/etc/gobgpd.conf:ro
    command: ["gobgpd", "-f", "/etc/gobgpd.conf"]
    restart: unless-stopped

  api:
    build: ./api
    container_name: bgp-api
    environment:
      - NODE_ENV=production
      - DB_PATH=/data/bgp.db
      - DEMO_MODE=${DEMO_MODE:-false}
      - GOBGP_BIN=/usr/local/bin/gobgp
      - WS_HEARTBEAT_MS=15000
    volumes:
      - api_data:/data
    depends_on:
      - gobgp
    ports:
      - "8080:8080"
    restart: unless-stopped

  web:
    build: ./web
    container_name: bgp-web
    depends_on:
      - api
    environment:
      - VITE_API_BASE=http://localhost:8080
    ports:
      - "5173:80"
    restart: unless-stopped

volumes:
  api_data:
```

> **Note:** `network_mode: host` keeps BGP peering simple. If you prefer a bridged network, expose TCP/179 explicitly and adjust routing.

## GoBGP Configuration (`gobgp/gobgpd.conf`)

```toml
[global.config]
  as = 65000
  router-id = "192.168.1.1"

[[neighbors]]
  [neighbors.config]
    neighbor-address = "192.168.1.254"
    peer-as = 65001

# Optional: Policy, timers, add-paths, etc.
```

## API Service (Fastify + SQLite + Collector)

### `api/package.json`

```json
{
  "name": "bgp-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint --max-warnings=0 \"src/**/*.{ts,tsx}\"",
    "lint:fix": "npm run lint -- --fix",
    "format": "prettier --check \"src/**/*.{ts,tsx,js,json}\"",
    "format:write": "prettier --write \"src/**/*.{ts,tsx,js,json}\""
  },
  "dependencies": {
    "@fastify/websocket": "^10.0.1",
    "better-sqlite3": "^12.4.1",
    "fastify": "^4.28.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^20.16.11",
    "@typescript-eslint/eslint-plugin": "^8.7.0",
    "@typescript-eslint/parser": "^8.7.0",
    "eslint": "^9.11.1",
    "eslint-config-prettier": "^9.1.0",
    "globals": "^15.9.0",
    "prettier": "^3.3.3",
    "tsx": "^4.19.0",
    "typescript": "^5.6.2",
    "vitest": "^3.2.4"
  }
}
```

### `api/src/schema.sql`

```sql
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS prefix (
  prefix TEXT PRIMARY KEY,
  origin_as INTEGER,
  next_hop TEXT,
  as_path TEXT,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS as_edge (
  src_as INTEGER,
  dst_as INTEGER,
  last_seen INTEGER,
  PRIMARY KEY (src_as, dst_as)
);

CREATE TABLE IF NOT EXISTS events (
  ts INTEGER,
  type TEXT,          -- 'announce' | 'withdraw'
  prefix TEXT,
  origin_as INTEGER,
  as_path TEXT,
  next_hop TEXT
);
```

### `api/src/db.ts`

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH ?? "./bgp.db";
const db = new Database(dbPath);

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
  db.prepare(`
    INSERT INTO events (ts, type, prefix, origin_as, as_path, next_hop)
    VALUES (@ts, @type, @prefix, @origin_as, @as_path, @next_hop)
  `).run({
    ...row,
    as_path: row.as_path ?? null,
    next_hop: row.next_hop ?? null,
  });
}

export function upsertEdgesFromASPath(asPath: string | undefined, ts: number): void {
  if (!asPath) return;
  const parts = asPath
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));

  for (let i = 0; i < parts.length - 1; i += 1) {
    const edge = { src: parts[i], dst: parts[i + 1], ts };
    db.prepare(`
      INSERT INTO as_edge (src_as, dst_as, last_seen)
      VALUES (@src, @dst, @ts)
      ON CONFLICT(src_as, dst_as) DO UPDATE SET last_seen = excluded.last_seen;
    `).run(edge);
  }
}

export function getSnapshot(): {
  nodes: Array<{ asn: number }>;
  edges: Array<{ src_as: number; dst_as: number }>;
} {
  const nodes = db
    .prepare(`SELECT DISTINCT origin_as AS asn FROM prefix WHERE origin_as IS NOT NULL`)
    .all() as Array<{ asn: number }>;
  const edges = db.prepare(`SELECT src_as, dst_as FROM as_edge`).all() as Array<{
    src_as: number;
    dst_as: number;
  }>;
  return { nodes, edges };
}
```

### `api/src/collector.ts`

```ts
import { spawn } from "node:child_process";
import { addEvent, upsertEdgesFromASPath, upsertPrefix } from "./db.js";

const GOBGP_BIN = process.env.GOBGP_BIN ?? "gobgp";
const DEMO_MODE = (process.env.DEMO_MODE ?? "false").toLowerCase() === "true";

export type AnnounceHandler = (payload: {
  ts: number;
  prefix: string;
  origin_as: number | null;
  as_path?: string;
  next_hop?: string | null;
}) => void;

export type WithdrawHandler = (payload: { ts: number; prefix: string }) => void;

// Helper functions to parse GoBGP JSON attributes
function extractOrigin(attrs: unknown[] | undefined): number | null {
  const typedAttrs = Array.isArray(attrs) ? attrs : [];
  const asPathAttr = typedAttrs.find(
    (attr: any) => typeof attr.type === "string" && attr.type.toLowerCase().includes("as_path"),
  );
  const values: number[] = Array.isArray(asPathAttr?.value)
    ? asPathAttr.value.flat().filter((v: unknown) => Number.isInteger(Number(v)))
    : [];
  return values.length > 0 ? values[values.length - 1] : null;
}

function extractASPath(attrs: unknown[] | undefined): string | undefined {
  const typedAttrs = Array.isArray(attrs) ? attrs : [];
  const asPathAttr = typedAttrs.find(
    (attr: any) => typeof attr.type === "string" && attr.type.toLowerCase().includes("as_path"),
  );
  const values = Array.isArray(asPathAttr?.value)
    ? asPathAttr.value.flat().filter((part: unknown) => Number.isInteger(Number(part)))
    : [];
  return values.map((part: unknown) => String(part)).join(" ");
}

function extractNextHop(attrs: unknown[] | undefined, fallback?: string | null): string | null {
  const typedAttrs = Array.isArray(attrs) ? attrs : [];
  const nh = typedAttrs.find((attr: any) => attr.type?.toLowerCase() === "next_hop");
  return nh?.nexthop ?? (typeof nh?.value === "string" ? nh.value : fallback) ?? null;
}

export async function initialRIBLoad(): Promise<void> {
  if (DEMO_MODE) return; // Skip in demo mode
  
  const proc = spawn(GOBGP_BIN, ["-j", "global", "rib"], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  proc.stdout.on("data", (chunk) => buffer += chunk.toString());
  
  await new Promise<void>((resolve) => proc.on("close", () => resolve()));
  
  if (!buffer.trim()) return;
  
  const entries = JSON.parse(buffer);
  const now = Date.now();
  
  for (const entry of entries) {
    const primary = entry.paths?.[0];
    const attrs = primary?.attrs;
    const origin_as = extractOrigin(attrs);
    const as_path = extractASPath(attrs);
    const next_hop = extractNextHop(attrs, primary?.nexthop) ?? null;
    
    upsertPrefix({ prefix: entry.prefix, origin_as, next_hop, as_path, ts: now });
    upsertEdgesFromASPath(as_path, now);
  }
}

export function startUpdateMonitor(
  onAnnounce: AnnounceHandler,
  onWithdraw: WithdrawHandler,
): () => void {
  if (DEMO_MODE) {
    // Generate synthetic announcements for demo mode
    const timer = setInterval(() => {
      const ts = Date.now();
      const asn = Math.floor(65000 + Math.random() * 1000);
      const nextAsn = asn + 1;
      onAnnounce({
        ts,
        prefix: `10.${asn % 255}.${nextAsn % 255}.0/24`,
        origin_as: asn,
        as_path: `${asn} ${nextAsn}`,
        next_hop: `192.0.2.${nextAsn % 255}`,
      });
    }, 1000);
    return () => clearInterval(timer);
  }

  // Monitor live BGP updates
  const proc = spawn(GOBGP_BIN, ["monitor", "global", "updates", "-j"], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  
  proc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      let update: any;
      try { update = JSON.parse(trimmed); } catch { continue; }
      
      const ts = Date.now();
      
      // Handle announcements
      if (update.announced) {
        for (const announcement of update.announced) {
          const prefix = announcement.nlri.prefix;
          const attrs = announcement.attrs || [];
          const origin_as = extractOrigin(attrs);
          const as_path = extractASPath(attrs);
          const next_hop = extractNextHop(attrs, announcement.nexthop);
          
          upsertPrefix({ prefix, origin_as, next_hop, as_path, ts });
          upsertEdgesFromASPath(as_path, ts);
          addEvent({ ts, type: "announce", prefix, origin_as, as_path, next_hop });
          onAnnounce({ ts, prefix, origin_as, as_path, next_hop });
        }
      }
      
      // Handle withdrawals
      if (update.withdrawn) {
        for (const withdrawal of update.withdrawn) {
          const prefix = withdrawal.prefix;
          addEvent({ ts, type: "withdraw", prefix, origin_as: null });
          onWithdraw({ ts, prefix });
        }
      }
    }
  });
  
  return () => proc.kill();
}
```

### `api/src/index.ts`

```ts
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";

try {
  const app = await createApp();
  await app.listen({ host, port });
  app.log.info({ port }, "API listening");
} catch (error) {
  console.error(error);
  process.exit(1);
}
```

### `api/src/app.ts`

```ts
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

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);

  await init();
  await initialRIBLoad();

  const clients = new Set<ClientSocket>();

  // REST: Snapshot (AS-level graph)
  app.get("/api/snapshot", async () => getSnapshot());

  // WebSocket: live events (announce/withdraw/heartbeat)
  app.get("/ws", { websocket: true }, (connection) => {
    const socket = (connection as any).socket ?? connection;
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });

  function broadcast(message: LiveMessage) {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch (error) {
        app.log.warn({ err: error }, "failed to deliver websocket message");
      }
    }
  }

  // Start update monitor with announce/withdraw handlers
  startUpdateMonitor(
    (payload) => broadcast({ type: "announce", ...payload }),
    (payload) => broadcast({ type: "withdraw", ...payload })
  );

  // Optional heartbeat for WebSocket keepalive
  const heartbeatMs = Number.parseInt(process.env.WS_HEARTBEAT_MS ?? "0", 10);
  if (heartbeatMs > 0) {
    const timer = setInterval(() => {
      broadcast({ type: "heartbeat", ts: Date.now() });
    }, heartbeatMs);
    app.addHook("onClose", () => clearInterval(timer));
  }

  return app;
}
```

### `api/src/types.ts`

```ts
export type SnapshotNode = { asn: number };
export type SnapshotEdge = { src_as: number; dst_as: number };

export type LiveAnnounce = {
  type: "announce";
  ts: number;
  prefix: string;
  origin_as: number | null;
  as_path?: string;
  next_hop?: string | null;
};

export type LiveWithdraw = {
  type: "withdraw";
  ts: number;
  prefix: string;
};

export type Heartbeat = {
  type: "heartbeat";
  ts: number;
};

export type LiveMessage = LiveAnnounce | LiveWithdraw | Heartbeat;
```

## Frontend (Vite + Canvas)

### `web/package.json`

```json
{
  "name": "bgp-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "lint": "eslint --max-warnings=0 \"src/**/*.{ts,tsx}\"",
    "lint:fix": "npm run lint -- --fix",
    "format": "prettier --check \"src/**/*.{ts,tsx,js,json,css}\"",
    "format:write": "prettier --write \"src/**/*.{ts,tsx,js,json,css}\""
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^8.7.0",
    "@typescript-eslint/parser": "^8.7.0",
    "eslint": "^9.11.1",
    "eslint-config-prettier": "^9.1.0",
    "globals": "^15.9.0",
    "happy-dom": "^20.0.3",
    "prettier": "^3.3.3",
    "typescript": "^5.6.2",
    "vite": "^7.1.10",
    "vitest": "^3.2.4"
  }
}
```

### `web/vite.config.ts`

```ts
import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist" },
});
```

### `web/index.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>BGP Live View</title>
  <style>
    html,body,#app { margin:0; height:100%; background:#0b0f14; color:#cbd5e1; font-family: system-ui,sans-serif; }
    .hud { position:fixed; top:10px; left:10px; background:#111827aa; padding:8px 12px; border-radius:10px; }
    canvas { display:block; }
  </style>
</head>
<body>
  <div class="hud">Wheel: Zoom · Drag: Pan · Click Node: Highlight</div>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### `web/src/api.ts`

```ts
function resolveApiBase(): string {
  const globalOverride = (globalThis as any)?.__VITE_API_BASE__;
  if (typeof globalOverride === "string" && globalOverride.length > 0) {
    return globalOverride;
  }
  const meta = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof meta === "string" && meta.length > 0) {
    return meta;
  }
  return "";
}

export async function fetchSnapshot(): Promise<{
  nodes: Array<{ asn: number }>;
  edges: Array<{ src_as: number; dst_as: number }>;
}> {
  const base = resolveApiBase();
  const res = await fetch(`${base}/api/snapshot`);
  if (!res.ok) {
    throw new Error(`Snapshot request failed with status ${res.status}`);
  }
  return res.json();
}

export function connectWS(onMessage: (payload: any) => void): WebSocket {
  const base = resolveApiBase() || (typeof window !== "undefined" ? window.location.origin : "");
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  const socket = new WebSocket(wsUrl);
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (error) {
      console.warn("Failed to parse websocket payload", error);
    }
  };
  return socket;
}
```

### `web/src/canvas.ts`

```ts
type Node = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Edge = {
  s: number;
  d: number;
};

export class CanvasGraph {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly nodes: Map<number, Node> = new Map();
  private edges: Edge[] = [];
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastFrame = performance.now();

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Unable to acquire 2D context");
    this.ctx = context;
    parent.appendChild(this.canvas);

    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(parent);
    this.resize();

    // Mouse wheel for zoom
    this.canvas.addEventListener("wheel", (event) => {
      const factor = event.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.canvas.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      
      // Zoom towards cursor position
      this.tx = cx - factor * (cx - this.tx);
      this.ty = cy - factor * (cy - this.ty);
      this.scale *= factor;
      event.preventDefault();
    }, { passive: false });

    // Mouse drag for pan
    this.canvas.addEventListener("mousedown", (event) => {
      this.dragging = true;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    });

    window.addEventListener("mousemove", (event) => {
      if (!this.dragging) return;
      this.tx += event.clientX - this.lastX;
      this.ty += event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
    });

    window.addEventListener("mouseup", () => {
      this.dragging = false;
    });

    requestAnimationFrame(() => this.frame());
  }

  setSnapshot(
    nodes: Array<{ asn: number }>,
    edges: Array<{ src_as: number; dst_as: number }>
  ): void {
    // Initialize nodes in a circle layout
    const nodeCount = nodes.length;
    nodes.forEach((node, index) => {
      if (!this.nodes.has(node.asn)) {
        const angle = (2 * Math.PI * index) / nodeCount;
        this.nodes.set(node.asn, {
          id: node.asn,
          x: 300 * Math.cos(angle),
          y: 300 * Math.sin(angle),
          vx: 0,
          vy: 0,
        });
      }
    });
    this.edges = edges.map((edge) => ({ s: edge.src_as, d: edge.dst_as }));
  }

  applyAnnounce(origin_as: number | null, as_path?: string): void {
    if (!as_path) return;
    const parts = as_path
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value));
    
    // Add new nodes from AS path
    parts.forEach((asn) => {
      if (!this.nodes.has(asn)) {
        this.nodes.set(asn, {
          id: asn,
          x: (Math.random() - 0.5) * 600,
          y: (Math.random() - 0.5) * 600,
          vx: 0,
          vy: 0,
        });
      }
    });
    
    // Add edges from AS path
    for (let i = 0; i < parts.length - 1; i += 1) {
      this.edges.push({ s: parts[i], d: parts[i + 1] });
    }
  }

  private resize(): void {
    this.canvas.width = this.canvas.clientWidth || 800;
    this.canvas.height = this.canvas.clientHeight || 600;
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.simulate(dt);
    this.draw();
    requestAnimationFrame(() => this.frame());
  }

  private simulate(dt: number): void {
    const spring = 0.02;
    const repulsion = 5000;
    const nodeArray = Array.from(this.nodes.values());

    // Node-node repulsion
    for (let i = 0; i < nodeArray.length; i += 1) {
      for (let j = i + 1; j < nodeArray.length; j += 1) {
        const dx = nodeArray[j].x - nodeArray[i].x;
        const dy = nodeArray[j].y - nodeArray[i].y;
        const distanceSquared = dx * dx + dy * dy + 0.01;
        const force = repulsion / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        const fx = (force * dx) / distance;
        const fy = (force * dy) / distance;
        
        nodeArray[i].vx -= fx * dt;
        nodeArray[i].vy -= fy * dt;
        nodeArray[j].vx += fx * dt;
        nodeArray[j].vy += fy * dt;
      }
    }

    // Edge springs
    for (const edge of this.edges) {
      const source = this.nodes.get(edge.s);
      const destination = this.nodes.get(edge.d);
      if (!source || !destination) continue;
      
      const dx = destination.x - source.x;
      const dy = destination.y - source.y;
      const fx = spring * dx;
      const fy = spring * dy;
      
      source.vx += fx * dt;
      source.vy += fy * dt;
      destination.vx -= fx * dt;
      destination.vy -= fy * dt;
    }

    // Integrate positions with damping
    for (const node of nodeArray) {
      node.x += node.vx * dt;
      node.y += node.vy * dt;
      node.vx *= 0.9;
      node.vy *= 0.9;
    }
  }

  private draw(): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    // Draw edges
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 / this.scale;
    ctx.strokeStyle = "#3b82f6";
    for (const edge of this.edges) {
      const source = this.nodes.get(edge.s);
      const destination = this.nodes.get(edge.d);
      if (!source || !destination) continue;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(destination.x, destination.y);
      ctx.stroke();
    }

    // Draw nodes
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e5e7eb";
    for (const node of this.nodes.values()) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, Math.max(2, 4 / this.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.restore();
  }
}
```

### `web/src/main.ts`

```ts
import { fetchSnapshot, connectWS } from "./api";
import { CanvasGraph } from "./canvas";

type LiveMessage =
  | { type: "announce"; origin_as: number | null; as_path?: string }
  | { type: "withdraw" }
  | { type: "heartbeat" };

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}

const graph = new CanvasGraph(root);

(async () => {
  const snapshot = await fetchSnapshot();
  graph.setSnapshot(snapshot.nodes, snapshot.edges);

  connectWS((message: LiveMessage & Record<string, any>) => {
    if (message.type === "announce") {
      graph.applyAnnounce(message.origin_as ?? null, message.as_path);
    }
    // Withdrawals and heartbeats are handled here if needed
  });
})();
```

## Environment Variables (`.env`)

```dotenv
DEMO_MODE=true
```

* `DEMO_MODE=true`: The API generates synthetic announcements (no BGP peer required).
* `DEMO_MODE=false` (default): The stack operates against a live GoBGP peer.

## Dockerfiles

### `api/Dockerfile`

```dockerfile
FROM ubuntu:latest AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    git \
    make \
    g++ \
    python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends tar \
    && rm -rf /var/lib/apt/lists/*
ARG GOBGP_VERSION=3.15.0
RUN curl -fsSL "https://github.com/osrg/gobgp/releases/download/v${GOBGP_VERSION}/gobgp_${GOBGP_VERSION}_linux_amd64.tar.gz" -o /tmp/gobgp.tar.gz \
    && tar -xzf /tmp/gobgp.tar.gz -C /tmp \
    && install -m 0755 /tmp/gobgp /usr/local/bin/gobgp \
    && install -m 0755 /tmp/gobgpd /usr/local/bin/gobgpd \
    && rm -rf /tmp/gobgp* \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY src/schema.sql dist/schema.sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

### `web/Dockerfile`

```dockerfile
FROM ubuntu:latest AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git \
        make \
        g++ \
        python3 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM ubuntu:latest AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist /var/www/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## Development

### Prerequisites

- Node.js 20+
- Docker and Docker Compose

### Development Setup

```bash
# 1. Clone the repository
git clone https://github.com/ralphschuler/TopoLens.git
cd TopoLens

# 2. Install dependencies for both packages
cd api && npm install && cd ../web && npm install && cd ..

# 3. Run tests and linting to verify setup
cd api && npm test && npm run lint && npm run format
cd ../web && npm test && npm run lint && npm run format

# 4. Start development servers
# Terminal 1 - API development server
cd api && npm run dev

# Terminal 2 - Web development server  
cd web && npm run dev

# 5. Open browser to http://localhost:5173
```

### Testing & Code Quality

Both `api/` and `web/` packages include comprehensive testing and code quality tools:

- **Unit Tests**: Vitest framework with tests in `src/__tests__/`
- **Linting**: ESLint with TypeScript rules
- **Formatting**: Prettier with consistent configuration
- **Type Checking**: Strict TypeScript configuration

```bash
# Run all quality checks
npm test && npm run lint && npm run format

# Auto-fix linting and formatting issues
npm run lint:fix && npm run format:write
```

## Quickstart (Docker)

```bash
# 1. Copy environment configuration
cp .env.example .env

# 2. For development/testing, enable demo mode
echo "DEMO_MODE=true" >> .env

# 3. Build and start all services
docker compose up --build

# Access points:
# Web UI:  http://localhost:5173
# API:     http://localhost:8080/api/snapshot
# WebSocket: ws://localhost:8080/ws
```

For production peering, set `DEMO_MODE=false`, update `gobgpd.conf` with your router information, and verify that the BGP session establishes successfully.

## Continuous Integration

The project includes GitHub Actions workflows for automated testing and quality assurance:

### PR Quality Gate (`.github/workflows/pr.yml`)

All pull requests must pass:
- **Unit Tests**: Full test suite for both API and web packages
- **Linting**: ESLint checks with zero warnings tolerance
- **Code Formatting**: Prettier formatting validation
- **Type Checking**: TypeScript compilation without errors

### Main Branch Automation (`.github/workflows/main.yml`)

The main branch includes additional automation for:
- Automatic code formatting fixes
- Dependency vulnerability scanning
- Container image building and scanning

## API Surface

* `GET /api/snapshot` → `{ nodes:[{asn}], edges:[{src_as,dst_as}] }`
* `WS /ws` → messages of the form:
  * `{"type":"announce","ts":..., "prefix":"x/y","origin_as":65000,"as_path":"65000 3356 15169","next_hop":"..." }`
  * `{"type":"withdraw","ts":..., "prefix":"x/y"}`

## Data Model & Aggregation

* **prefix**: Tracks the most recent state per prefix for quick lookups.
* **as_edge**: Stores deduplicated AS-level edges derived from AS paths (`last_seen` enables aging).
* **events**: Maintains the full change log for playback or forensic analysis.

### Performance Notes

* For full Internet tables, render only the AS graph to keep the visualization manageable.
* Age edges (for example, nightly delete edges where `last_seen < now-30d`).
* Consider paginating or simplifying the snapshot endpoint if you anticipate large responses.

## Troubleshooting

* **BGP session down**: Verify router configuration, firewalls, and TCP/179 reachability; inspect GoBGP logs.
* **Missing JSON output**: Ensure the container image includes GoBGP (`apk add gobgp` in the API image).
* **Empty visualization**: Enable `DEMO_MODE=true` for smoke tests.
* **Slow canvas performance**: Limit node count (e.g., top-AS by degree), throttle edge additions, or reduce layout iterations.

## Security & Operations

* Expose the stack only on trusted networks when possible.
* SQLite lives in the `api_data` volume with WAL mode enabled for durability.
* Add rate limiting for REST/WS endpoints if you plan to expose them externally (Fastify plug-ins).
* Health checks can be added to the API container for better observability.

## Roadmap

* Advanced filters (search by AS, communities, IPv4/IPv6 selectors).
* History playback (time scrubber for the events log).
* Geo-visualization (map integration once you maintain local GeoIP data).
* BMP ingestion (alternative collector path if you prefer BMP exports).
