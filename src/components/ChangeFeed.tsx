import type { TopologyChange, TopologyChangeType } from "../topology/routeTracker";
import { cn } from "../lib/utils";
import { formatAbsolute, formatRelative } from "../lib/format";

interface ChangeStyle {
  label: string;
  shortLabel: string;
  marker: string;
  classes: string;
}

export const CHANGE_STYLES: Record<TopologyChangeType, ChangeStyle> = {
  "first-observed": {
    label: "First observed",
    shortLabel: "FIRST",
    marker: "+",
    classes: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  },
  "path-changed": {
    label: "Path changed",
    shortLabel: "PATH Δ",
    marker: "Δ",
    classes: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  },
  "origin-changed": {
    label: "Origin changed",
    shortLabel: "ORIGIN Δ",
    marker: "Δ",
    classes: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  },
  withdrawn: {
    label: "Withdrawn",
    shortLabel: "WITHDRAWN",
    marker: "−",
    classes: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  },
  "withdrawal-observed": {
    label: "Unresolved withdrawal",
    shortLabel: "UNRESOLVED",
    marker: "?",
    classes: "border-slate-500/40 bg-slate-700/30 text-slate-200",
  },
};

function PathPreview({ change }: { change: TopologyChange }) {
  if (change.type === "withdrawn") {
    return <span>{change.previousPathDisplay || "Known route"} → withdrawn</span>;
  }
  if (change.type === "withdrawal-observed") {
    return <span>No local route baseline</span>;
  }
  if (change.type === "first-observed") {
    return <span>{change.currentPathDisplay || "AS path unavailable"}</span>;
  }
  return (
    <span>
      {change.previousPathDisplay || "Unknown"} → {change.currentPathDisplay || "Unknown"}
    </span>
  );
}

export interface ChangeFeedProps {
  changes: TopologyChange[];
  selectedSequence: number | null;
  onSelect: (change: TopologyChange) => void;
  now: number;
}

export function ChangeFeed({
  changes,
  selectedSequence,
  onSelect,
  now,
}: ChangeFeedProps): JSX.Element {
  if (changes.length === 0) {
    return (
      <div className="flex min-h-56 flex-1 items-center justify-center p-5 text-center">
        <div className="max-w-xs">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 font-mono text-sm text-slate-400">
            Δ
          </div>
          <p className="text-sm font-medium text-slate-200">No matching topology changes</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Keep the stream running to establish route baselines, or widen the current filters.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ol className="custom-scrollbar flex-1 overflow-y-auto" aria-label="Topology changes">
      {changes.map((change) => {
        const style = CHANGE_STYLES[change.type];
        const selected = selectedSequence === change.sequence;
        return (
          <li key={change.sequence} className="border-b border-slate-800/70 last:border-b-0">
            <button
              id={`topology-change-${change.sequence}`}
              type="button"
              onClick={() => onSelect(change)}
              aria-pressed={selected}
              className={cn(
                "group w-full px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400",
                selected ? "bg-cyan-400/[0.08]" : "hover:bg-slate-800/40",
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-8 min-w-8 items-center justify-center rounded-lg border font-mono text-xs font-bold",
                    style.classes,
                  )}
                  aria-hidden="true"
                >
                  {style.marker}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[13px] font-semibold text-slate-100">
                      {change.prefix}
                    </span>
                    <time
                      dateTime={new Date(change.timestamp).toISOString()}
                      title={formatAbsolute(change.timestamp)}
                      className="shrink-0 font-mono text-[10px] text-slate-500"
                    >
                      {formatRelative(change.timestamp, now)}
                    </time>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wide",
                        style.classes,
                      )}
                    >
                      {style.shortLabel}
                    </span>
                    {change.addedEdges.length > 0 && (
                      <span className="font-mono text-[10px] text-emerald-300">
                        +{change.addedEdges.length} edge
                        {change.addedEdges.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {change.removedEdges.length > 0 && (
                      <span className="font-mono text-[10px] text-rose-300">
                        −{change.removedEdges.length} edge
                        {change.removedEdges.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  <span className="mt-2 block truncate font-mono text-[10px] text-slate-400">
                    <PathPreview change={change} />
                  </span>
                  <span className="mt-1.5 block truncate text-[10px] text-slate-500">
                    {change.collector} · {change.peer}
                  </span>
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
