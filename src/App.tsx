import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { useRipeRis } from "./hooks/useRipeRis";
import type { PersistedUpdate } from "./db/indexedDb";

type GraphNodeExtra = {
  label: string;
  type: "peer" | "prefix" | "origin";
};

type GraphLinkExtra = {
  kind: PersistedUpdate["kind"];
};

type GraphNode = NodeObject<GraphNodeExtra>;
type GraphLink = LinkObject<GraphNodeExtra, GraphLinkExtra>;

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (Number.isNaN(diff) || !Number.isFinite(diff)) return "just now";
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function UpdateRow({ update }: { update: PersistedUpdate }) {
  return (
    <li className="update-item">
      <div className="update-title">
        {update.kind === "announce" ? "Announce" : "Withdraw"} {update.prefix}
      </div>
      <div className="update-meta">
        <span>Peer: {update.peer}</span>
        {typeof update.peerAsn === "number" && <span>AS{update.peerAsn}</span>}
        {typeof update.originAs === "number" && <span>Origin AS{update.originAs}</span>}
        <span>{formatTimestamp(update.timestamp)}</span>
        <span>{formatRelative(update.receivedAt)}</span>
      </div>
      {update.asPath && (
        <div className="update-meta">
          <span>AS Path: {update.asPath}</span>
        </div>
      )}
      {update.nextHop && (
        <div className="update-meta">
          <span>Next Hop: {update.nextHop}</span>
        </div>
      )}
    </li>
  );
}

export default function App(): JSX.Element {
  const { status, updates, error, reconnect, clearHistory } = useRipeRis(50);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [graphSize, setGraphSize] = useState({ width: 0, height: 0 });
  const graphContainerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNodeExtra, GraphLinkExtra>>();
  const hasFitGraphRef = useRef(false);

  useEffect(() => {
    const node = graphContainerRef.current;
    if (!node) return;
    const updateSize = () => {
      setGraphSize({ width: node.clientWidth, height: node.clientHeight });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      if (typeof window !== "undefined") {
        window.addEventListener("resize", updateSize);
        return () => window.removeEventListener("resize", updateSize);
      }
      return;
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { matcher: filterMatcher, error: filterError } = useMemo(() => {
    const trimmed = filterQuery.trim();
    if (!trimmed) {
      return { matcher: () => true, error: null as string | null };
    }

    if (useRegex) {
      try {
        const regex = new RegExp(trimmed, "i");
        return {
          matcher: (update: PersistedUpdate) =>
            [
              update.prefix,
              update.peer,
              update.nextHop,
              update.asPath,
              update.kind,
              typeof update.originAs === "number" ? `AS${update.originAs}` : null,
              typeof update.peerAsn === "number" ? `AS${update.peerAsn}` : null,
            ]
              .filter((value): value is string => Boolean(value))
              .some((value) => regex.test(value)),
          error: null,
        };
      } catch (regexError) {
        return {
          matcher: () => false,
          error: regexError instanceof Error ? regexError.message : "Invalid regular expression",
        };
      }
    }

    const lowered = trimmed.toLowerCase();
    return {
      matcher: (update: PersistedUpdate) =>
        [
          update.prefix,
          update.peer,
          update.nextHop,
          update.asPath,
          update.kind,
          typeof update.originAs === "number" ? `AS${update.originAs}` : null,
          typeof update.peerAsn === "number" ? `AS${update.peerAsn}` : null,
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(lowered)),
      error: null,
    };
  }, [filterQuery, useRegex]);

  const filteredUpdates = useMemo(
    () => updates.filter((update) => filterMatcher(update)),
    [filterMatcher, updates],
  );

  const graphData = useMemo((): { nodes: GraphNode[]; links: GraphLink[] } => {
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];

    for (const update of filteredUpdates) {
      const peerId = `peer:${update.peer}`;
      if (!nodes.has(peerId)) {
        nodes.set(peerId, { id: peerId, label: update.peer, type: "peer" });
      }

      const prefixId = `prefix:${update.prefix}`;
      if (!nodes.has(prefixId)) {
        nodes.set(prefixId, { id: prefixId, label: update.prefix, type: "prefix" });
      }

      links.push({ source: peerId, target: prefixId, kind: update.kind });

      if (typeof update.originAs === "number") {
        const originId = `origin:${update.originAs}`;
        if (!nodes.has(originId)) {
          nodes.set(originId, { id: originId, label: `AS${update.originAs}`, type: "origin" });
        }
        links.push({ source: originId, target: prefixId, kind: update.kind });
      }
    }

    return { nodes: Array.from(nodes.values()), links };
  }, [filteredUpdates]);

  useEffect(() => {
    if (!graphRef.current || graphData.nodes.length === 0 || graphSize.width === 0 || graphSize.height === 0) {
      return;
    }

    if (!hasFitGraphRef.current) {
      graphRef.current.zoomToFit(400, 50);
      hasFitGraphRef.current = true;
    }
  }, [graphData.nodes.length, graphSize.height, graphSize.width]);

  useEffect(() => {
    if (!graphRef.current) return;
    if (graphData.nodes.length === 0) return;
    graphRef.current.d3ReheatSimulation();
  }, [graphData.links.length, graphData.nodes.length]);

  useEffect(() => {
    hasFitGraphRef.current = false;
  }, [filterQuery, isFiltersOpen, useRegex]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case "connected":
        return "Connected to RIPE RIS";
      case "connecting":
        return "Connecting to RIPE RIS";
      case "error":
      default:
        return "Disconnected";
    }
  }, [status]);

  return (
    <main>
      <section className="panel app-header">
        <div className="status-bar">
          <div className="title-group">
            <h1>TopoLens</h1>
            <span className="status-pill" data-state={status}>
              {statusLabel}
            </span>
          </div>
          <div className="header-actions">
            <button className="secondary" type="button" onClick={() => setIsFiltersOpen((value) => !value)}>
              {isFiltersOpen ? "Hide filters" : "Show filters"}
            </button>
            <button className="secondary" type="button" onClick={() => setIsLogsOpen((value) => !value)}>
              {isLogsOpen ? "Hide logs" : "Show logs"}
            </button>
            <button className="secondary" type="button" onClick={reconnect}>
              Reconnect
            </button>
            <button className="secondary" type="button" onClick={clearHistory}>
              Clear stored updates
            </button>
          </div>
        </div>
        <p>
          Streaming live BGP announcements from the{" "}
          <a href="https://ris-live.ripe.net/" target="_blank" rel="noreferrer">
            RIPE RIS Live API
          </a>
          . Updates are persisted locally using your browser&apos;s IndexedDB for replay.
        </p>
        {error && <p className="error-text">{error}</p>}
      </section>

      <section className="panel graph-panel">
        <div className="graph-header">
          <h2>Live connectivity map</h2>
          <span>{filteredUpdates.length} visible update{filteredUpdates.length === 1 ? "" : "s"}</span>
        </div>
        <div className="graph-canvas" ref={graphContainerRef}>
          {graphSize.width > 0 && graphSize.height > 0 ? (
            <ForceGraph2D<GraphNodeExtra, GraphLinkExtra>
              ref={graphRef}
              graphData={graphData}
              width={graphSize.width}
              height={graphSize.height}
              cooldownTime={1500}
              nodeRelSize={6}
              nodeCanvasObject={(node, ctx, globalScale) => {
                const typedNode = node as GraphNode;
                const radius = 6;
                const colors: Record<GraphNodeExtra["type"], string> = {
                  peer: "#60a5fa",
                  prefix: "#f97316",
                  origin: "#34d399",
                };
                ctx.fillStyle = colors[typedNode.type];
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI, false);
                ctx.fill();
                const label = typedNode.label;
                if (!label) return;
                const fontSize = Math.max(10, 14 / globalScale);
                ctx.font = `${fontSize}px Inter, system-ui`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = "#e2e8f0";
                ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + radius + 2);
              }}
              nodePointerAreaPaint={(node, color, ctx) => {
                const radius = 8;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI, false);
                ctx.fill();
              }}
              linkColor={(link) => (link.kind === "announce" ? "rgba(59, 130, 246, 0.6)" : "rgba(248, 113, 113, 0.6)")}
              linkDirectionalParticles={2}
              linkDirectionalParticleSpeed={() => 0.004}
              linkDirectionalParticleWidth={2}
              enableNodeDrag={false}
              d3VelocityDecay={0.3}
            />
          ) : (
            <div className="empty-state">Preparing graph…</div>
          )}
        </div>
      </section>

      <aside className={`filter-drawer${isFiltersOpen ? " open" : ""}`}>
        <div className="drawer-header">
          <h2>Filters</h2>
          <button className="secondary" type="button" onClick={() => setIsFiltersOpen(false)}>
            Close
          </button>
        </div>
        <div className="drawer-content">
          <label htmlFor="filter-query">Filter updates by text or regex</label>
          <input
            id="filter-query"
            type="text"
            placeholder="Example: 192.0.2.0/24 or AS64496"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
          />
          <div className="filter-options">
            <label className="checkbox">
              <input type="checkbox" checked={useRegex} onChange={(event) => setUseRegex(event.target.checked)} />
              Use regular expression
            </label>
            {filterQuery && (
              <button className="secondary" type="button" onClick={() => setFilterQuery("")}>
                Clear
              </button>
            )}
          </div>
          {filterError && <p className="error-text">{filterError}</p>}
          <p className="drawer-helper">
            Matching is applied to peers, prefixes, ASNs, and paths. Use filters to focus the live graph and logs on specific
            routes.
          </p>
        </div>
      </aside>

      <aside className={`log-drawer${isLogsOpen ? " open" : ""}`}>
        <div className="drawer-header">
          <h2>Recent updates</h2>
          <button className="secondary" type="button" onClick={() => setIsLogsOpen(false)}>
            Close
          </button>
        </div>
        <div className="drawer-content logs-content">
          {filteredUpdates.length === 0 ? (
            <div className="empty-state">No updates match the current filters.</div>
          ) : (
            <ul className="updates-list">
              {filteredUpdates.map((update) => (
                <UpdateRow
                  update={update}
                  key={update.id ?? `${update.prefix}-${update.timestamp}-${update.kind}`}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </main>
  );
}
