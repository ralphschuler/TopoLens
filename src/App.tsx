import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ChangeFeed } from "./components/ChangeFeed";
import { ChangeInspector } from "./components/ChangeInspector";
import { ScopeDialog } from "./components/ScopeDialog";
import SigmaGraph from "./components/SigmaGraph";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useGraphData } from "./hooks/useGraphData";
import { useRipeRis, type ConnectionState } from "./hooks/useRipeRis";
import { formatCount, formatDuration, formatRelative, isIpv6Prefix } from "./lib/format";
import { cn } from "./lib/utils";
import type { TopologyChange, TopologyChangeType, TrackedRoute } from "./topology/routeTracker";
import type { GraphNodePayload } from "./workers/messages";

type MobileView = "map" | "changes";
type AddressFamily = "all" | "ipv4" | "ipv6";
type TimeWindow = "5m" | "15m" | "60m" | "session";
type ChangeTypeFilter = "all" | TopologyChangeType;

const MAX_VISIBLE_CHANGES = 300;

const WINDOW_MS: Record<Exclude<TimeWindow, "session">, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "60m": 60 * 60_000,
};

const STATUS: Record<ConnectionState, { label: string; color: string }> = {
  connecting: { label: "Connecting", color: "bg-amber-300" },
  connected: { label: "Live", color: "bg-emerald-300" },
  reconnecting: { label: "Reconnecting", color: "bg-amber-300" },
  error: { label: "Stream error", color: "bg-rose-400" },
  paused: { label: "Paused", color: "bg-sky-300" },
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

function matchesAddressFamily(prefix: string, family: AddressFamily): boolean {
  if (family === "all") return true;
  return family === "ipv6" ? isIpv6Prefix(prefix) : !isIpv6Prefix(prefix);
}

function normalizeSearch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^as(?=\d)/, "");
}

function routeMatches(route: TrackedRoute, query: string, family: AddressFamily): boolean {
  if (!matchesAddressFamily(route.prefix, family)) return false;
  if (!query) return true;
  return [
    route.prefix,
    route.peer,
    route.collector,
    route.asPathDisplay,
    route.originAs,
    route.peerAsn,
    route.nextHop,
  ].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query),
  );
}

function changeMatches(change: TopologyChange, query: string, family: AddressFamily): boolean {
  if (!matchesAddressFamily(change.prefix, family)) return false;
  if (!query) return true;
  return [
    change.prefix,
    change.peer,
    change.collector,
    change.previousPathDisplay,
    change.currentPathDisplay,
    change.previousOrigin?.kind === "asn" ? change.previousOrigin.asn : "",
    change.currentOrigin?.kind === "asn" ? change.currentOrigin.asn : "",
  ].some((value) => String(value).toLowerCase().includes(query));
}

function StatusPill({ status, retryInMs }: { status: ConnectionState; retryInMs: number | null }) {
  const config = STATUS[status];
  return (
    <span
      className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/80 px-3 font-mono text-[10px] font-bold uppercase tracking-wider text-slate-200"
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          config.color,
          status === "connecting" && "animate-pulse",
        )}
      />
      {config.label}
      {status === "reconnecting" && retryInMs !== null && (
        <span className="text-slate-500">{Math.ceil(retryInMs / 1_000)}s</span>
      )}
    </span>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800/90 bg-slate-950/70 px-3 py-2.5">
      <p className="telemetry-label">{label}</p>
      <p className="mt-1 truncate font-mono text-lg font-semibold text-slate-100">{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-slate-500" title={detail}>
        {detail}
      </p>
    </div>
  );
}

function SelectControl({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="min-w-0">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="control-select w-full min-w-28"
      >
        {children}
      </select>
    </label>
  );
}

function ScopeSummary({
  collector,
  prefix,
  path,
}: {
  collector: string;
  prefix: string;
  path: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-slate-500">
      <span className="text-cyan-300">{collector}</span>
      <span>{prefix || "all prefixes"}</span>
      {path && <span>path:{path}</span>}
      <span className="rounded border border-amber-400/20 bg-amber-400/[0.06] px-1.5 py-0.5 text-amber-200">
        session partial
      </span>
    </div>
  );
}

export default function App(): JSX.Element {
  const now = useNow();
  const {
    snapshot,
    workerStatus,
    subscription,
    sessionStartedAt,
    lastUpdateAt,
    error,
    gaps,
    isPaused,
    pendingUpdateCount,
    droppedPausedUpdates,
    retryInMs,
    pause,
    resume,
    reconnect,
    clearSession,
    configure,
  } = useRipeRis();

  const [mobileView, setMobileView] = useState<MobileView>("map");
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<AddressFamily>("all");
  const [changeType, setChangeType] = useState<ChangeTypeFilter>("all");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("15m");
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [graphRenderError, setGraphRenderError] = useState<string | null>(null);
  const [graphRendererKey, setGraphRendererKey] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const search = normalizeSearch(query);
  const filteredRoutes = useMemo(
    () => snapshot.routes.filter((route) => routeMatches(route, search, family)),
    [family, search, snapshot.routes],
  );

  const filteredChanges = useMemo(() => {
    const cutoff = timeWindow === "session" ? sessionStartedAt : now - WINDOW_MS[timeWindow];
    return snapshot.changes
      .filter((change) => change.receivedAt >= cutoff)
      .filter((change) => changeType === "all" || change.type === changeType)
      .filter((change) => changeMatches(change, search, family))
      .reverse();
  }, [changeType, family, now, search, sessionStartedAt, snapshot.changes, timeWindow]);

  const mapChanges = useMemo(
    () => snapshot.changes.filter((change) => changeMatches(change, search, family)).reverse(),
    [family, search, snapshot.changes],
  );

  const selectedChange = useMemo(
    () =>
      selectedSequence === null
        ? null
        : (snapshot.changes.find((change) => change.sequence === selectedSequence) ?? null),
    [selectedSequence, snapshot.changes],
  );
  const graphSelectedChange =
    selectedChange && changeMatches(selectedChange, search, family) ? selectedChange : null;
  const graphFocusChange = graphSelectedChange ?? mapChanges[0] ?? null;
  const displayedChanges = filteredChanges.slice(0, MAX_VISIBLE_CHANGES);
  const {
    graph,
    isComputing,
    error: graphWorkerError,
  } = useGraphData(filteredRoutes, graphFocusChange);
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const sessionDuration = Math.max(1_000, now - sessionStartedAt);
  const updatesPerMinute = snapshot.stats.updatesReceived / (sessionDuration / 60_000);
  const latestGap = gaps[gaps.length - 1];
  const hasRetentionLoss =
    snapshot.stats.evictedRoutes > 0 ||
    snapshot.stats.droppedChanges > 0 ||
    droppedPausedUpdates > 0 ||
    graph.meta.truncated;
  const graphError = graphWorkerError || graphRenderError;

  const selectChange = (change: TopologyChange) => {
    setSelectedSequence(change.sequence);
    setMobileView("changes");
  };

  const restartSession = () => {
    setSelectedSequence(null);
    setSelectedNodeId(null);
    setGraphRenderError(null);
    setGraphRendererKey((current) => current + 1);
    clearSession();
  };

  const closeInspector = () => {
    const sequence = selectedSequence;
    setSelectedSequence(null);
    if (sequence !== null) {
      requestAnimationFrame(() => {
        document.getElementById(`topology-change-${sequence}`)?.focus();
      });
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-3 py-2.5 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/[0.08] font-mono text-xs font-black text-cyan-300 shadow-lg shadow-cyan-950/30">
              TL
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h1 className="truncate text-base font-bold tracking-tight text-white sm:text-lg">
                  TopoLens
                </h1>
                <span className="hidden font-mono text-[9px] uppercase tracking-[0.18em] text-slate-600 sm:inline">
                  RIS live topology
                </span>
              </div>
              <ScopeSummary {...subscription} />
            </div>
          </div>

          <StatusPill status={workerStatus} retryInMs={retryInMs} />
          {isPaused && (
            <span
              role="status"
              className="hidden h-9 items-center rounded-full border border-sky-300/20 bg-sky-400/[0.07] px-3 font-mono text-[10px] font-bold uppercase tracking-wider text-sky-200 md:inline-flex"
            >
              display paused
            </span>
          )}
          <div className="hidden items-center gap-2 sm:flex">
            <Button variant="outline" size="sm" onClick={isPaused ? resume : pause}>
              {isPaused
                ? `Resume${pendingUpdateCount ? ` (${formatCount(pendingUpdateCount)})` : ""}`
                : "Pause"}
            </Button>
            <Button variant="ghost" size="sm" onClick={reconnect}>
              Reconnect
            </Button>
            <Button variant="ghost" size="sm" onClick={restartSession}>
              Reset
            </Button>
            <Button size="sm" onClick={() => setScopeOpen(true)}>
              Scope
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] space-y-3 px-3 py-3 pb-24 sm:px-5 sm:py-4 lg:pb-5">
        <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Session telemetry">
          <Metric
            label="Active routes"
            value={formatCount(filteredRoutes.length)}
            detail={`${formatCount(snapshot.stats.trackedRoutes)} retained · current scope`}
          />
          <Metric
            label="AS topology"
            value={`${formatCount(graph.meta.nodes.included)} / ${formatCount(graph.meta.links.included)}`}
            detail="nodes / active + overlay links"
          />
          <Metric
            label="Changes"
            value={formatCount(filteredChanges.length)}
            detail={`${formatCount(snapshot.stats.changesObserved)} observed this session`}
          />
          <Metric
            label="Update rate"
            value={`${updatesPerMinute.toFixed(updatesPerMinute < 10 ? 1 : 0)}/m`}
            detail={`uptime ${formatDuration(sessionDuration)}`}
          />
        </section>

        {(error || latestGap || hasRetentionLoss || isPaused || pendingUpdateCount > 0) && (
          <section className="space-y-2" aria-label="Observation notices">
            {error && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/25 bg-rose-400/[0.07] px-3 py-2.5 text-xs text-rose-100"
              >
                <span>{error}</span>
                <Button variant="outline" size="sm" onClick={reconnect}>
                  Retry
                </Button>
              </div>
            )}
            {isPaused && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/25 bg-sky-400/[0.07] px-3 py-2.5 text-xs text-sky-100">
                <span>
                  Display paused · {formatCount(pendingUpdateCount)} updates buffered locally.
                </span>
                <Button variant="outline" size="sm" onClick={resume}>
                  Apply buffer
                </Button>
              </div>
            )}
            {!isPaused && pendingUpdateCount > 0 && (
              <div
                role="status"
                className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2.5 text-xs text-cyan-100"
              >
                Applying paused updates in small batches · {formatCount(pendingUpdateCount)}{" "}
                remaining.
              </div>
            )}
            {latestGap && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs text-amber-100">
                Observation gap: {latestGap.reason} ·{" "}
                {latestGap.endedAt
                  ? formatDuration(latestGap.endedAt - latestGap.startedAt)
                  : "open"}
                {latestGap.droppedUpdates
                  ? ` · ${formatCount(latestGap.droppedUpdates)} updates dropped`
                  : ""}
              </div>
            )}
            {hasRetentionLoss && (
              <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2.5 text-xs text-slate-300">
                Bounded view: older state may be outside local retention or graph limits. Counters
                remain session-wide.
              </div>
            )}
          </section>
        )}

        <section className="topology-panel p-2.5 sm:p-3" aria-label="View filters">
          <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto_auto_auto]">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter ASN, prefix, peer, collector or path…"
              aria-label="Filter topology and changes"
              spellCheck={false}
              className="font-mono"
            />
            <SelectControl
              label="Address family"
              value={family}
              onChange={(value) => setFamily(value as AddressFamily)}
            >
              <option value="all">IPv4 + IPv6</option>
              <option value="ipv4">IPv4 only</option>
              <option value="ipv6">IPv6 only</option>
            </SelectControl>
            <SelectControl
              label="Change type"
              value={changeType}
              onChange={(value) => setChangeType(value as ChangeTypeFilter)}
            >
              <option value="all">All changes</option>
              <option value="path-changed">Path changed</option>
              <option value="origin-changed">Origin changed</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="withdrawal-observed">Unresolved withdrawal</option>
              <option value="first-observed">First observed</option>
            </SelectControl>
            <SelectControl
              label="Change time window"
              value={timeWindow}
              onChange={(value) => setTimeWindow(value as TimeWindow)}
            >
              <option value="5m">Last 5 min</option>
              <option value="15m">Last 15 min</option>
              <option value="60m">Last 60 min</option>
              <option value="session">Full session</option>
            </SelectControl>
          </div>
          <p className="mt-2 px-1 text-[10px] text-slate-600">
            Search and address family filter map + feed. Change type and time window filter the feed
            only.
          </p>
        </section>

        <nav
          className="grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-950 p-1 lg:hidden"
          aria-label="Mobile view"
        >
          {(["map", "changes"] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setMobileView(view)}
              aria-current={mobileView === view ? "page" : undefined}
              className={cn(
                "h-11 rounded-lg font-mono text-xs font-bold uppercase tracking-wider transition",
                mobileView === view
                  ? "bg-cyan-400 text-slate-950"
                  : "text-slate-400 hover:bg-slate-900 hover:text-white",
              )}
            >
              {view === "map" ? "Map" : `Changes · ${formatCount(filteredChanges.length)}`}
            </button>
          ))}
        </nav>

        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_390px]">
          <section
            className={cn(
              "topology-panel min-h-[58dvh] flex-col lg:flex lg:h-[calc(100dvh-21rem)] lg:min-h-[560px]",
              mobileView === "map" ? "flex" : "hidden",
            )}
            aria-label="Autonomous system topology map"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-3 py-3 sm:px-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-100">AS adjacency map</h2>
                  {isComputing && (
                    <span className="font-mono text-[9px] uppercase tracking-wider text-cyan-300">
                      syncing
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  Active route state · latest visible change overlaid
                  {lastUpdateAt ? ` · wire ${formatRelative(lastUpdateAt, now)}` : ""}
                </p>
              </div>
              <div className="flex min-w-48 flex-col items-end gap-2">
                <label className="w-full max-w-56">
                  <span className="sr-only">Inspect an autonomous system node</span>
                  <select
                    aria-label="Inspect an autonomous system node"
                    value={selectedNode?.id ?? ""}
                    onChange={(event) => setSelectedNodeId(event.target.value || null)}
                    className="control-select w-full font-mono"
                  >
                    <option value="">Inspect AS node…</option>
                    {graph.nodes.map((node) => (
                      <option value={node.id} key={node.id}>
                        {node.label} · {node.routeCount} route
                        {node.routeCount === 1 ? "" : "s"}
                        {node.changeState === "unchanged" ? "" : ` · ${node.changeState}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-wide">
                  <span className="text-emerald-300">● added to path</span>
                  <span className="text-rose-300">● removed from path</span>
                  <span className="text-slate-500">● active</span>
                </div>
              </div>
            </header>
            <div className="graph-canvas relative min-h-0 flex-1 bg-slate-950">
              <SigmaGraph
                key={graphRendererKey}
                nodes={graph.nodes}
                links={graph.links}
                className="absolute inset-0"
                onError={(renderError) => setGraphRenderError(renderError.message)}
                onReady={() => setGraphRenderError(null)}
                onNodeSelect={(node: GraphNodePayload) => setSelectedNodeId(node.id)}
              />
              {selectedNode && (
                <section
                  aria-live="polite"
                  className="absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] rounded-xl border border-cyan-300/20 bg-slate-950/95 p-3 shadow-xl backdrop-blur"
                >
                  <div className="flex items-start gap-4">
                    <div>
                      <p className="telemetry-label">Selected node</p>
                      <h3 className="mt-1 font-mono text-sm font-bold text-cyan-200">
                        {selectedNode.label}
                      </h3>
                      <p className="mt-1 text-[10px] text-slate-400">
                        {formatCount(selectedNode.routeCount)} supporting route
                        {selectedNode.routeCount === 1 ? "" : "s"} ·{" "}
                        {selectedNode.active ? "active" : "historical ghost"}
                        {selectedNode.changeState === "unchanged"
                          ? ""
                          : ` · ${selectedNode.changeState} in focused path`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSelectedNodeId(null)}
                      aria-label={`Close details for ${selectedNode.label}`}
                    >
                      ×
                    </Button>
                  </div>
                </section>
              )}
              {graphError ? (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/80 p-6 text-center backdrop-blur-[1px]">
                  <div className="max-w-sm">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 font-mono text-cyan-300">
                      AS
                    </div>
                    <p className="text-sm font-semibold text-slate-200">
                      Graph renderer unavailable
                    </p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">{graphError}</p>
                    {!graphWorkerError && (
                      <Button
                        variant="outline"
                        className="mt-4"
                        onClick={() => {
                          setGraphRenderError(null);
                          setGraphRendererKey((current) => current + 1);
                        }}
                      >
                        Retry renderer
                      </Button>
                    )}
                  </div>
                </div>
              ) : graph.nodes.length === 0 ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/65 p-6 text-center backdrop-blur-[1px]">
                  <div className="max-w-sm">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 font-mono text-cyan-300">
                      AS
                    </div>
                    <p className="text-sm font-semibold text-slate-200">Building a live baseline</p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      TopoLens has no initial RIB snapshot. AS links appear as announcements
                      establish route state for this session.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-3 py-2 font-mono text-[9px] text-slate-500 sm:px-4">
              <span>
                {formatCount(graph.meta.routes.included)}/{formatCount(graph.meta.routes.total)}{" "}
                routes projected
              </span>
              <span>
                {formatCount(graph.meta.nodes.included)} nodes ·{" "}
                {formatCount(graph.meta.links.included)} links
              </span>
            </footer>
          </section>

          <aside
            className={cn(
              "topology-panel min-h-[58dvh] flex-col lg:flex lg:h-[calc(100dvh-21rem)] lg:min-h-[560px]",
              mobileView === "changes" ? "flex" : "hidden",
            )}
            aria-label="Topology change stream"
          >
            {selectedChange ? (
              <ChangeInspector change={selectedChange} onClose={closeInspector} />
            ) : (
              <>
                <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">Topology changes</h2>
                    <p className="mt-1 text-[10px] text-slate-500">
                      Newest first · showing {formatCount(displayedChanges.length)} of{" "}
                      {formatCount(filteredChanges.length)}
                    </p>
                  </div>
                  <span className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[10px] text-slate-300">
                    {formatCount(filteredChanges.length)}
                  </span>
                </header>
                <ChangeFeed
                  changes={displayedChanges}
                  selectedSequence={graphFocusChange?.sequence ?? null}
                  onSelect={selectChange}
                  now={now}
                />
              </>
            )}
          </aside>
        </div>
      </main>

      <div className="pb-safe fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-slate-800 bg-slate-950/95 px-3 pt-2 backdrop-blur sm:hidden">
        <Button variant="outline" className="flex-1" onClick={isPaused ? resume : pause}>
          {isPaused ? `Resume · ${formatCount(pendingUpdateCount)}` : "Pause stream"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={reconnect}
          aria-label="Reconnect to RIS Live"
          title="Reconnect"
        >
          ↻
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={restartSession}
          aria-label="Clear local session state"
          title="Reset local session"
        >
          ⌫
        </Button>
        <Button className="flex-1" onClick={() => setScopeOpen(true)}>
          Scope
        </Button>
      </div>

      <ScopeDialog
        open={scopeOpen}
        subscription={subscription}
        onClose={() => setScopeOpen(false)}
        onApply={(nextSubscription) => {
          setSelectedSequence(null);
          setSelectedNodeId(null);
          setGraphRenderError(null);
          setGraphRendererKey((current) => current + 1);
          configure(nextSubscription);
        }}
      />
    </div>
  );
}
