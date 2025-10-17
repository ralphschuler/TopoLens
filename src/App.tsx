import { useMemo, useState } from "react";

import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import SigmaGraph from "./components/SigmaGraph";
import { useGraphData } from "./hooks/useGraphData";
import { useRipeRis } from "./hooks/useRipeRis";
import { cn } from "./lib/utils";
import type { RipeUpdate, UpdateKind } from "./utils/ris";

type FieldKey =
  | "prefix"
  | "peer"
  | "peerAsn"
  | "originAs"
  | "nextHop"
  | "asPath"
  | "host"
  | "timestamp"
  | "receivedAt"
  | "kind";

interface FieldConfig {
  key: FieldKey;
  label: string;
  placeholder: string;
  extractor: (update: RipeUpdate) => Array<string | number | null | undefined>;
}

function createEmptyFieldFilters(): Record<FieldKey, string> {
  return {
    prefix: "",
    peer: "",
    peerAsn: "",
    originAs: "",
    nextHop: "",
    asPath: "",
    host: "",
    timestamp: "",
    receivedAt: "",
    kind: "",
  };
}

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

const FIELD_CONFIGS: FieldConfig[] = [
  {
    key: "prefix",
    label: "Prefix",
    placeholder: "e.g. 192.0.2.0/24",
    extractor: (update) => [update.prefix],
  },
  {
    key: "peer",
    label: "BGP client (peer)",
    placeholder: "e.g. 198.51.100.1",
    extractor: (update) => [update.peer],
  },
  {
    key: "peerAsn",
    label: "Peer ASN",
    placeholder: "e.g. 64496",
    extractor: (update) =>
      typeof update.peerAsn === "number" ? [update.peerAsn, `AS${update.peerAsn}`] : [],
  },
  {
    key: "originAs",
    label: "Origin ASN",
    placeholder: "e.g. 13335",
    extractor: (update) =>
      typeof update.originAs === "number" && Number.isFinite(update.originAs)
        ? [update.originAs, `AS${update.originAs}`]
        : [],
  },
  {
    key: "nextHop",
    label: "Next hop",
    placeholder: "e.g. 203.0.113.10",
    extractor: (update) => [update.nextHop ?? null],
  },
  {
    key: "asPath",
    label: "AS path",
    placeholder: "e.g. 64512 64513",
    extractor: (update) => [update.asPath ?? null],
  },
  {
    key: "host",
    label: "Collector host",
    placeholder: "e.g. rrc00",
    extractor: (update) => [update.host ?? null],
  },
  {
    key: "timestamp",
    label: "Announcement timestamp",
    placeholder: "e.g. 2024-05-01",
    extractor: (update) => {
      const date = new Date(update.timestamp);
      return [update.timestamp, date.toISOString(), date.toLocaleString()];
    },
  },
  {
    key: "receivedAt",
    label: "Received at",
    placeholder: "e.g. 5m ago",
    extractor: (update) => {
      const date = new Date(update.receivedAt);
      return [update.receivedAt, date.toISOString(), date.toLocaleString(), formatRelative(update.receivedAt)];
    },
  },
  {
    key: "kind",
    label: "Message kind",
    placeholder: "announce | withdraw",
    extractor: (update) => [update.kind],
  },
];

function UpdateRow({ update }: { update: RipeUpdate }) {
  const badgeVariant = update.kind === "announce" ? "success" : "destructive";
  return (
    <li className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-4 transition hover:border-mystic-400/40 hover:bg-slate-900/80">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">
          {update.kind === "announce" ? "Announce" : "Withdraw"} {update.prefix}
        </p>
        <Badge variant={badgeVariant} className="capitalize">
          {update.kind}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-400">
        <span>
          Peer: <span className="text-slate-200">{update.peer}</span>
        </span>
        {update.host && (
          <span>
            Collector: <span className="text-slate-200">{update.host}</span>
          </span>
        )}
        {typeof update.peerAsn === "number" && (
          <span>
            Peer ASN: <span className="text-slate-200">AS{update.peerAsn}</span>
          </span>
        )}
        {typeof update.originAs === "number" && (
          <span>
            Origin: <span className="text-slate-200">AS{update.originAs}</span>
          </span>
        )}
        <span>
          At <span className="text-slate-200">{formatTimestamp(update.timestamp)}</span>
        </span>
        <span className="text-slate-300/70">{formatRelative(update.receivedAt)}</span>
      </div>
      {update.asPath && (
        <p className="mt-3 text-xs text-slate-300/80">
          <span className="font-medium text-slate-200">AS Path:</span> {update.asPath}
        </p>
      )}
      {update.nextHop && (
        <p className="mt-1 text-xs text-slate-300/80">
          <span className="font-medium text-slate-200">Next Hop:</span> {update.nextHop}
        </p>
      )}
    </li>
  );
}

export default function App(): JSX.Element {
  const { status, updates, error, reconnect, clearHistory } = useRipeRis(50);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [isLogsOpen, setIsLogsOpen] = useState(true);
  const [globalQuery, setGlobalQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [fieldFilters, setFieldFilters] = useState<Record<FieldKey, string>>(createEmptyFieldFilters);
  const [kindFilters, setKindFilters] = useState<Record<UpdateKind, boolean>>({
    announce: true,
    withdraw: true,
  });
  const [showIpv4, setShowIpv4] = useState(true);
  const [showIpv6, setShowIpv6] = useState(true);

  const { matcher: filterMatcher, errors: filterErrors } = useMemo(() => {
    const errors: string[] = [];
    const matchers: Array<(update: RipeUpdate) => boolean> = [];

    const compileMatcher = (
      label: string,
      value: string,
      extractor: (update: RipeUpdate) => Array<string | number | null | undefined>,
    ) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (useRegex) {
        try {
          const regex = new RegExp(trimmed, "i");
          matchers.push((update: RipeUpdate) => {
            const candidates = extractor(update)
              .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
              .filter((entry): entry is string | number => entry !== null && entry !== undefined)
              .map((entry) => String(entry));
            if (candidates.length === 0) return false;
            return candidates.some((candidate) => regex.test(candidate));
          });
        } catch (regexError) {
          errors.push(`${label}: ${regexError instanceof Error ? regexError.message : "Invalid regular expression"}`);
          matchers.push(() => false);
        }
        return;
      }

      const lowered = trimmed.toLowerCase();
      matchers.push((update: RipeUpdate) => {
        const candidates = extractor(update)
          .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
          .filter((entry): entry is string | number => entry !== null && entry !== undefined)
          .map((entry) => String(entry).toLowerCase());
        if (candidates.length === 0) return false;
        return candidates.some((candidate) => candidate.includes(lowered));
      });
    };

    const globalTrim = globalQuery.trim();
    if (globalTrim) {
      compileMatcher("Global", globalTrim, (update) => [
        update.prefix,
        update.peer,
        update.host,
        update.nextHop,
        update.asPath,
        update.kind,
        typeof update.peerAsn === "number" ? update.peerAsn : null,
        typeof update.peerAsn === "number" ? `AS${update.peerAsn}` : null,
        typeof update.originAs === "number" ? update.originAs : null,
        typeof update.originAs === "number" ? `AS${update.originAs}` : null,
      ]);
    }

    for (const field of FIELD_CONFIGS) {
      compileMatcher(field.label, fieldFilters[field.key], field.extractor);
    }

    const matcher = (update: RipeUpdate) => {
      if (!kindFilters[update.kind]) {
        return false;
      }

      const isIpv6Prefix = update.prefix.includes(":");
      if (isIpv6Prefix && !showIpv6) return false;
      if (!isIpv6Prefix && !showIpv4) return false;

      return matchers.every((fn) => fn(update));
    };

    return { matcher, errors };
  }, [fieldFilters, globalQuery, kindFilters, showIpv4, showIpv6, useRegex]);

  const filteredUpdates = useMemo(
    () => updates.filter((update) => filterMatcher(update)),
    [filterMatcher, updates],
  );

  const {
    graph: graphData,
    isComputing: isGraphComputing,
    error: graphError,
  } = useGraphData(filteredUpdates);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (globalQuery.trim()) count += 1;
    count += Object.values(fieldFilters).filter((value) => value.trim()).length;
    if (!kindFilters.announce || !kindFilters.withdraw) count += 1;
    if (!showIpv4 || !showIpv6) count += 1;
    return count;
  }, [fieldFilters, globalQuery, kindFilters, showIpv4, showIpv6]);

  const handleFieldFilterChange = (key: FieldKey, value: string) => {
    setFieldFilters((previous) => ({ ...previous, [key]: value }));
  };

  const resetFilters = () => {
    setGlobalQuery("");
    setFieldFilters(createEmptyFieldFilters());
    setKindFilters({ announce: true, withdraw: true });
    setShowIpv4(true);
    setShowIpv6(true);
    setUseRegex(false);
  };

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

  const statusBadgeVariant = status === "connected" ? "success" : status === "connecting" ? "warning" : "destructive";
  const statusHelper =
    status === "connected"
      ? "Streaming live BGP announcements"
      : status === "connecting"
        ? "Negotiating websocket session"
        : "Tap reconnect to retry the stream";

  const closeOverlays = () => {
    setIsFiltersOpen(false);
  };

  const totalNodes = graphData.nodes.length;
  const totalLinks = graphData.links.length;

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-40 bg-mystic-overlay" />
      <div className="pointer-events-none absolute inset-0 -z-30 bg-mystic-grid opacity-25" />
      {isFiltersOpen && (
        <button
          type="button"
          aria-label="Close filters"
          onClick={closeOverlays}
          className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm"
        />
      )}

      <div className="relative z-0 min-h-screen">
        <div className="absolute inset-0 -z-20">
          <SigmaGraph nodes={graphData.nodes} links={graphData.links} className="h-full w-full" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-slate-950/70 via-slate-950/40 to-slate-950/80" />
        </div>

        {totalNodes === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/80 px-5 py-4 text-sm text-slate-200">
              {isGraphComputing ? "Building network view…" : "No routes available for the current filters."}
            </div>
          </div>
        )}

        <div className="relative z-30 mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
          <Card className="relative overflow-hidden border-slate-800/40 bg-slate-900/75 backdrop-blur">
            <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-mystic-500/20 via-transparent to-slate-900/0" />
            <CardHeader className="gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300/80">
                  <Badge variant={statusBadgeVariant}>{statusLabel}</Badge>
                  <span>{statusHelper}</span>
                </div>
                <div>
                  <CardTitle className="text-3xl text-white">TopoLens</CardTitle>
                  <CardDescription className="max-w-xl text-base text-slate-300">
                    Observe global BGP relationships in near real-time through a mystic violet lens. Recent updates stay in memory for quick exploration during your session.
                  </CardDescription>
                </div>
                {error && <p className="text-sm text-rose-300">{error}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={() => setIsFiltersOpen((value) => !value)}>
                  {isFiltersOpen ? "Hide filters" : "Show filters"}
                  {activeFilterCount > 0 && (
                    <span className="ml-2 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded-full bg-mystic-500/20 px-2 text-xs text-mystic-100">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsLogsOpen((value) => !value)}
                  aria-expanded={isLogsOpen}
                  aria-controls="recent-updates-drawer"
                >
                  {isLogsOpen ? "Hide logs" : "Show logs"}
                </Button>
                <Button variant="outline" onClick={reconnect}>
                  Reconnect
                </Button>
                <Button variant="ghost" onClick={clearHistory}>
                  Clear recent updates
                </Button>
              </div>
            </CardHeader>
          </Card>

          <Card className="relative border-slate-800/40 bg-slate-900/70 backdrop-blur">
            <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-mystic-500/15 via-transparent to-slate-900/0" />
            <CardHeader className="flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <CardTitle className="text-2xl text-white">Live connectivity map</CardTitle>
                <CardDescription className="text-slate-300/80">
                  {filteredUpdates.length} visible update{filteredUpdates.length === 1 ? "" : "s"}
                </CardDescription>
                {graphError && <p className="text-sm text-rose-300">{graphError}</p>}
              </div>
              <div className="flex flex-col items-start gap-2 text-xs text-slate-300/70 md:items-end">
                {isGraphComputing && (
                  <Badge className="bg-mystic-500/20 text-mystic-100">Updating graph…</Badge>
                )}
                <div className="flex items-center gap-3">
                  <span>Nodes: {totalNodes}</span>
                  <span>Connections: {totalLinks}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-4 text-xs text-slate-300/80">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#c4b5fd]" />
                <span>Peers</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#8b5cf6]" />
                <span>Prefixes</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
                <span>Origin AS</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-6 rounded-full bg-gradient-to-r from-purple-400/70 to-purple-500/60" />
                <span>Announce link</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-6 rounded-full bg-gradient-to-r from-rose-400/70 to-rose-500/60" />
                <span>Withdraw link</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <aside
        id="recent-updates-drawer"
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-md transform transition-transform duration-300 ease-in-out",
          isLogsOpen ? "translate-x-0" : "translate-x-full",
        )}
        aria-hidden={!isLogsOpen}
      >
        <div className="flex h-full flex-col border-l border-slate-800/60 bg-slate-950/85 backdrop-blur">
          <div className="flex items-start justify-between border-b border-slate-800/60 p-5">
            <div>
              <h2 className="text-lg font-semibold text-white">Recent updates</h2>
              <p className="text-xs text-slate-300/80">
                {filteredUpdates.length === 0
                  ? "No updates match the current filters."
                  : "Latest captured BGP events"}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setIsLogsOpen(false)}>
              Close
            </Button>
          </div>
          <div className="custom-scrollbar flex-1 overflow-y-auto p-5 pr-4">
            {filteredUpdates.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-700/60 bg-slate-900/60 p-6 text-sm text-slate-300">
                No updates match the current filters.
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {filteredUpdates.map((update) => (
                  <UpdateRow
                    update={update}
                    key={`${update.prefix}-${update.timestamp}-${update.kind}`}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>

      <div
        className={cn(
          "fixed left-1/2 top-12 z-60 w-[min(520px,92%)] -translate-x-1/2 transform transition-all duration-300",
          isFiltersOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none -translate-y-6 opacity-0",
        )}
      >
        <Card className="border-slate-800/50 bg-slate-900/90 shadow-xl shadow-mystic-900/40">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-xl text-white">Filters</CardTitle>
              <CardDescription className="text-sm text-slate-300/80">
                Target specific peers, prefixes, ASNs, and message metadata.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {activeFilterCount > 0 && (
                <Badge className="bg-mystic-500/20 text-mystic-100">{activeFilterCount} active</Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => setIsFiltersOpen(false)}>
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex max-h-[75vh] flex-col gap-6 overflow-y-auto pr-1">
            <div className="flex flex-col gap-2">
              <label htmlFor="global-filter" className="text-sm font-medium text-slate-200">
                Search every field
              </label>
              <Input
                id="global-filter"
                type="text"
                placeholder="Quick search across peers, prefixes, ASNs, and paths"
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELD_CONFIGS.map((field) => (
                <div key={field.key} className="flex flex-col gap-2">
                  <label
                    htmlFor={`filter-${field.key}`}
                    className="text-xs font-semibold uppercase tracking-wide text-slate-300/90"
                  >
                    {field.label}
                  </label>
                  <Input
                    id={`filter-${field.key}`}
                    type="text"
                    placeholder={field.placeholder}
                    value={fieldFilters[field.key]}
                    onChange={(event) => handleFieldFilterChange(field.key, event.target.value)}
                  />
                </div>
              ))}
            </div>
            {filterErrors.length > 0 && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                <p className="font-semibold">Regex error</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {filterErrors.map((message, index) => (
                    <li key={`${message}-${index}`}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2 rounded-xl border border-slate-800/60 bg-slate-900/80 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300/80">Message kinds</p>
                <Checkbox
                  checked={kindFilters.announce}
                  onChange={(event) => setKindFilters((prev) => ({ ...prev, announce: event.target.checked }))}
                  label="Show announces"
                />
                <Checkbox
                  checked={kindFilters.withdraw}
                  onChange={(event) => setKindFilters((prev) => ({ ...prev, withdraw: event.target.checked }))}
                  label="Show withdrawals"
                />
              </div>
              <div className="flex flex-col gap-2 rounded-xl border border-slate-800/60 bg-slate-900/80 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300/80">Address families</p>
                <Checkbox
                  checked={showIpv4}
                  onChange={(event) => setShowIpv4(event.target.checked)}
                  label="Include IPv4 prefixes"
                />
                <Checkbox
                  checked={showIpv6}
                  onChange={(event) => setShowIpv6(event.target.checked)}
                  label="Include IPv6 prefixes"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <Checkbox
                checked={useRegex}
                onChange={(event) => setUseRegex(event.target.checked)}
                label="Use regular expressions for text filters"
              />
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Reset filters
              </Button>
            </div>
            <p className="text-xs text-slate-400/80">
              Filters apply to both the graph and the recent updates log. Enable regex mode for advanced matching.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
