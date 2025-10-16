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
bgp-visualizer/
├─ docker-compose.yml
├─ .env
├─ gobgp/
│  └─ gobgpd.conf
├─ api/
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ src/
│  │  ├─ index.ts           # Fastify REST + WebSocket server
│  │  ├─ db.ts              # SQLite bootstrap & queries
│  │  ├─ collector.ts       # RIB + update reader (spawns gobgp)
│  │  ├─ schema.sql
│  │  └─ types.ts
│  └─ vite.config.ts        # Optional Vite config for dev ergonomics
└─ web/
   ├─ index.html
   ├─ package.json
   ├─ tsconfig.json
   ├─ vite.config.ts
   └─ src/
      ├─ main.ts
      ├─ canvas.ts          # Rendering, pan/zoom, layout
      └─ api.ts             # REST/WS client helpers
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
  router-id = "192.168.1.10"

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
    "start": "node dist/src/index.js"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.0",
    "fastify": "^4.28.1",
    "@fastify/websocket": "^10.0.1"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.2"
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
import Database from "better-sqlite3";
const db = new Database(process.env.DB_PATH || "./bgp.db");

export function init() {
  db.exec(require("fs").readFileSync(new URL("./schema.sql", import.meta.url), "utf-8"));
}

export function upsertPrefix(p: {
  prefix: string; origin_as: number|null; next_hop?: string|null; as_path?: string|null; ts: number;
}) {
  const stmt = db.prepare(`
    INSERT INTO prefix (prefix, origin_as, next_hop, as_path, last_seen)
    VALUES (@prefix, @origin_as, @next_hop, @as_path, @ts)
    ON CONFLICT(prefix) DO UPDATE SET
      origin_as=excluded.origin_as,
      next_hop=excluded.next_hop,
      as_path=excluded.as_path,
      last_seen=excluded.last_seen;
  `);
  stmt.run(p);
}

export function addEvent(e: { ts:number; type:string; prefix:string; origin_as:number|null; as_path?:string|null; next_hop?:string|null; }) {
  db.prepare(`INSERT INTO events (ts,type,prefix,origin_as,as_path,next_hop)
              VALUES (@ts,@type,@prefix,@origin_as,@as_path,@next_hop)`).run(e);
}

export function upsertEdgesFromASPath(asPath: string, ts:number) {
  const parts = (asPath || "").split(/\s+/).map(x => parseInt(x,10)).filter(Boolean);
  for (let i=0;i<parts.length-1;i++){
    db.prepare(`
      INSERT INTO as_edge (src_as, dst_as, last_seen)
      VALUES (@src,@dst,@ts)
      ON CONFLICT(src_as,dst_as) DO UPDATE SET last_seen=excluded.last_seen;
    `).run({src: parts[i], dst: parts[i+1], ts});
  }
}

export function getSnapshot() {
  const nodes = db.prepare(`SELECT DISTINCT origin_as as asn FROM prefix WHERE origin_as IS NOT NULL`).all();
  const edges = db.prepare(`SELECT src_as, dst_as FROM as_edge`).all();
  return { nodes, edges };
}
```

### `api/src/collector.ts`

```ts
import { spawn } from "node:child_process";
import { addEvent, upsertEdgesFromASPath, upsertPrefix } from "./db.js";

const GOBGP = process.env.GOBGP_BIN || "gobgp";
const DEMO = (process.env.DEMO_MODE || "false").toLowerCase() === "true";

type UpdateMsg = {
  type: "A"|"W";
  announced?: Array<{ nlri: { prefix: string }, attrs?: any[] }>;
  withdrawn?: Array<{ prefix: string }>;
  // GoBGP JSON varies; this is heavily simplified
};

function parseOriginAS(attrs:any[]): number|null {
  const asPathAttr = (attrs||[]).find((a:any)=>a.type && a.type.toLowerCase().includes("as_path"));
  if (!asPathAttr || !Array.isArray(asPathAttr.value)) return null;
  const flat = asPathAttr.value.flat().filter((n:any)=>Number.isInteger(n));
  return flat.length ? flat[flat.length-1] : null;
}
function parseASPath(attrs:any[]): string {
  const asPathAttr = (attrs||[]).find((a:any)=>a.type && a.type.toLowerCase().includes("as_path"));
  const flat = asPathAttr?.value?.flat?.() ?? [];
  return flat.join(" ");
}
function parseNextHop(attrs:any[]): string|undefined {
  const nh = (attrs||[]).find((a:any)=>a.type?.toLowerCase()==="next_hop");
  return nh?.nexthop || nh?.value;
}

export async function initialRIBLoad() {
  if (DEMO) return; // skip in demo mode
  const rib = spawn(GOBGP, ["-j", "global", "rib"], { stdio: ["ignore","pipe","inherit"] });
  let buf = ""; rib.stdout.on("data", chunk => buf += chunk.toString());
  await new Promise<void>(resolve => rib.on("close", ()=>resolve()));
  const arr = JSON.parse(buf);
  const now = Date.now();
  for (const r of arr) {
    const prefix = r.prefix;
    const p0 = r.paths?.[0] || {};
    const attrs = p0.attrs || [];
    const origin_as = parseOriginAS(attrs);
    const as_path = parseASPath(attrs);
    const next_hop = parseNextHop(attrs) || p0.nexthop || null;
    upsertPrefix({ prefix, origin_as, next_hop, as_path, ts: now });
    if (as_path) upsertEdgesFromASPath(as_path, now);
  }
}

export function startUpdateMonitor(onAnnounce:(msg:any)=>void, onWithdraw:(msg:any)=>void) {
  if (DEMO) {
    // Simple generator for testing
    setInterval(()=>{
      const ts = Date.now();
      const a = Math.floor(65000 + Math.random()*1000);
      const b = a + 1;
      onAnnounce({ ts, prefix:`10.${a%255}.${b%255}.0/24`, origin_as:a, as_path:`${a} ${b}`, next_hop:`192.0.2.${b%255}` });
    }, 1000);
    return;
  }
  const mon = spawn(GOBGP, ["monitor", "global", "updates", "-j"], { stdio:["ignore","pipe","inherit"] });
  mon.stdout.on("data", chunk => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim(); if (!trimmed) continue;
      let j: UpdateMsg; try { j = JSON.parse(trimmed); } catch { continue; }
      const ts = Date.now();
      if (j.announced) {
        for (const a of j.announced) {
          const prefix = a.nlri.prefix;
          const attrs = a.attrs || [];
          const origin_as = parseOriginAS(attrs);
          const as_path = parseASPath(attrs);
          const next_hop = parseNextHop(attrs);
          upsertPrefix({ prefix, origin_as, next_hop, as_path, ts });
          if (as_path) upsertEdgesFromASPath(as_path, ts);
          addEvent({ ts, type:"announce", prefix, origin_as, as_path, next_hop });
          onAnnounce({ ts, prefix, origin_as, as_path, next_hop });
        }
      }
      if (j.withdrawn) {
        for (const w of j.withdrawn) {
          addEvent({ ts, type:"withdraw", prefix:w.prefix, origin_as:null });
          onWithdraw({ ts, prefix:w.prefix });
        }
      }
    }
  });
}
```

### `api/src/index.ts`

```ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { init, getSnapshot } from "./db.js";
import { initialRIBLoad, startUpdateMonitor } from "./collector.js";

const app = Fastify({ logger: true });
await app.register(websocket);

init();
await initialRIBLoad();

// REST: Snapshot (AS-level graph)
app.get("/api/snapshot", async () => getSnapshot());

// WebSocket: live events (announce/withdraw)
type Client = { send: (data:string)=>void };
const clients = new Set<Client>();

app.get("/ws", { websocket: true }, (conn, req) => {
  clients.add(conn.socket);
  conn.socket.on("close", () => clients.delete(conn.socket));
});

function broadcast(obj:any) {
  const s = JSON.stringify(obj);
  for (const c of clients) try { (c as any).send(s); } catch {}
}

// Kick off the update monitor
startUpdateMonitor(
  (a)=>broadcast({ type:"announce", ...a }),
  (w)=>broadcast({ type:"withdraw", ...w })
);

const PORT = 8080;
app.listen({ host:"0.0.0.0", port: PORT });
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
    "build": "vite build"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.6.2",
    "vite": "^5.4.0"
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
const API_BASE = (import.meta as any).env.VITE_API_BASE || "";

export async function fetchSnapshot() {
  const res = await fetch(`${API_BASE}/api/snapshot`);
  return res.json(); // { nodes:[{asn:number}], edges:[{src_as,dst_as}] }
}

export function connectWS(onMsg:(m:any)=>void) {
  const url = (API_BASE || location.origin).replace(/^http/,"ws") + "/ws";
  const ws = new WebSocket(url);
  ws.onmessage = ev => { try { onMsg(JSON.parse(ev.data)); } catch {} };
  return ws;
}
```

### `web/src/canvas.ts`

```ts
type Node = { id:number; x:number; y:number; vx:number; vy:number; fixed?:boolean; };
type Edge = { s:number; d:number; };

export class CanvasGraph {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes = new Map<number,Node>();
  private edges: Edge[] = [];
  private scale=1, tx=0, ty=0;
  private dragging=false; private lx=0; private ly=0;

  constructor(parent:HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
    parent.appendChild(this.canvas);
    new ResizeObserver(()=>this.resize()).observe(parent);
    this.resize();

    this.canvas.addEventListener("wheel", e=>{
      const f = e.deltaY<0?1.1:0.9;
      const rect = this.canvas.getBoundingClientRect();
      const cx = (e.clientX-rect.left), cy=(e.clientY-rect.top);
      // zoom towards the cursor
      this.tx = cx - f*(cx - this.tx);
      this.ty = cy - f*(cy - this.ty);
      this.scale *= f;
      e.preventDefault();
    }, { passive:false });

    this.canvas.addEventListener("mousedown", e=>{ this.dragging=true; this.lx=e.clientX; this.ly=e.clientY; });
    window.addEventListener("mousemove", e=>{
      if (!this.dragging) return;
      this.tx += (e.clientX-this.lx);
      this.ty += (e.clientY-this.ly);
      this.lx = e.clientX; this.ly = e.clientY;
    });
    window.addEventListener("mouseup", ()=> this.dragging=false);

    requestAnimationFrame(()=>this.frame());
  }

  resize() { this.canvas.width = this.canvas.clientWidth; this.canvas.height = this.canvas.clientHeight; }

  setSnapshot(nlist:{asn:number}[], elist:{src_as:number;dst_as:number}[]) {
    // initialize nodes on a circle
    const N = nlist.length;
    nlist.forEach((n, i) => {
      if (!this.nodes.has(n.asn)) {
        const a = 2*Math.PI*i/N;
        this.nodes.set(n.asn, { id:n.asn, x: 300*Math.cos(a), y: 300*Math.sin(a), vx:0, vy:0 });
      }
    });
    this.edges = elist.map(e=>({ s:e.src_as, d:e.dst_as }));
  }

  applyAnnounce(origin_as:number|undefined, as_path?:string) {
    if (!as_path) return;
    const parts = as_path.split(/\s+/).map(x=>parseInt(x,10)).filter(Boolean);
    for (const asn of parts) if (!this.nodes.has(asn)) this.nodes.set(asn, { id:asn, x: (Math.random()-0.5)*600, y:(Math.random()-0.5)*600, vx:0, vy:0 });
    for (let i=0;i<parts.length-1;i++){
      this.edges.push({ s:parts[i], d:parts[i+1] });
    }
  }

  private simulate(dt:number) {
    // simple forces: springs + repulsion
    const k = 0.02, rep=5000;
    const a = Array.from(this.nodes.values());
    // repulsion
    for (let i=0;i<a.length;i++)
      for (let j=i+1;j<a.length;j++){
        const dx=a[j].x-a[i].x, dy=a[j].y-a[i].y, r2=dx*dx+dy*dy+0.01;
        const f = rep / r2;
        const fx = f*dx/Math.sqrt(r2); const fy=f*dy/Math.sqrt(r2);
        a[i].vx -= fx*dt; a[i].vy -= fy*dt; a[j].vx += fx*dt; a[j].vy += fy*dt;
      }
    // springs
    for (const e of this.edges){
      const s=this.nodes.get(e.s), d=this.nodes.get(e.d); if (!s||!d) continue;
      const dx=d.x-s.x, dy=d.y-s.y; const fx = k*dx, fy = k*dy;
      s.vx += fx*dt; s.vy += fy*dt; d.vx -= fx*dt; d.vy -= fy*dt;
    }
    // integrate + damping
    for (const n of a){ n.x += n.vx*dt; n.y += n.vy*dt; n.vx*=0.9; n.vy*=0.9; }
  }

  private draw() {
    const {ctx,canvas}=this;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.save();
    ctx.translate(this.tx, this.ty); ctx.scale(this.scale, this.scale);

    // edges
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1/this.scale;
    ctx.strokeStyle = "#3b82f6";
    for (const e of this.edges){
      const s=this.nodes.get(e.s), d=this.nodes.get(e.d); if (!s||!d) continue;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(d.x, d.y); ctx.stroke();
    }

    // nodes
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#e5e7eb";
    for (const n of this.nodes.values()){
      ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(2, 4/this.scale), 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  private last = performance.now();
  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last)/1000);
    this.last = now;
    this.simulate(dt);
    this.draw();
    requestAnimationFrame(()=>this.frame());
  }
}
```

### `web/src/main.ts`

```ts
import { fetchSnapshot, connectWS } from "./api";
import { CanvasGraph } from "./canvas";

const root = document.getElementById("app")!;
const graph = new CanvasGraph(root);

(async () => {
  const snap = await fetchSnapshot();
  graph.setSnapshot(snap.nodes, snap.edges);

  connectWS((msg)=>{
    if (msg.type === "announce") {
      graph.applyAnnounce(msg.origin_as, msg.as_path);
    }
    // Withdrawals are ignored for now; optionally fade/remove edges.
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
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache gobgp
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY src/schema.sql dist/src/schema.sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
```

### `web/Dockerfile`

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

## Quickstart

```bash
# 1) Populate the repository with the files above
# 2) Optionally set DEMO_MODE=true to run without a live BGP peer
docker compose up --build

# Web UI:  http://localhost:5173
# API:     http://localhost:8080/api/snapshot   (WebSocket: ws://localhost:8080/ws)
```

For production peering, set `DEMO_MODE=false`, update `gobgpd.conf` with your router information, and verify that the BGP session establishes successfully.

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
