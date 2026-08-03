import { Button } from "./ui/button";
import { CHANGE_STYLES } from "./ChangeFeed";
import type { AsEdge, TopologyChange } from "../topology/routeTracker";
import { formatAbsolute, formatOrigin } from "../lib/format";

function EdgeList({
  title,
  edges,
  tone,
}: {
  title: string;
  edges: AsEdge[];
  tone: "add" | "remove";
}) {
  const color = tone === "add" ? "text-emerald-200" : "text-rose-200";
  const background =
    tone === "add"
      ? "border-emerald-400/20 bg-emerald-400/[0.06]"
      : "border-rose-400/20 bg-rose-400/[0.06]";

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
          {title}
        </h3>
        <span className={`font-mono text-[10px] ${color}`}>{edges.length}</span>
      </div>
      {edges.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2 font-mono text-[10px] text-slate-600">
          none
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {edges.map((edge) => (
            <li
              key={edge.key}
              className={`rounded-lg border px-2 py-1 font-mono text-[10px] ${background} ${color}`}
            >
              AS{edge.source} ↔ AS{edge.target}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChangeSummary({ change }: { change: TopologyChange }) {
  switch (change.type) {
    case "first-observed":
      return (
        <>
          First route state observed during this session. It may have existed before TopoLens
          connected.
        </>
      );
    case "path-changed":
      return (
        <>The retained route now uses a different AS path while its origin remained unchanged.</>
      );
    case "origin-changed":
      return <>The final origin segment changed relative to the previous retained route state.</>;
    case "withdrawn":
      return <>A withdrawal matched and removed a route known to this session.</>;
    case "withdrawal-observed":
      return (
        <>A withdrawal arrived without a matching local baseline. No removed path was inferred.</>
      );
  }
}

export interface ChangeInspectorProps {
  change: TopologyChange;
  onClose: () => void;
}

export function ChangeInspector({ change, onClose }: ChangeInspectorProps): JSX.Element {
  const style = CHANGE_STYLES[change.type];
  return (
    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            Change inspector
          </p>
          <p className="truncate font-mono text-sm font-semibold text-slate-100">{change.prefix}</p>
        </div>
        <Button
          autoFocus
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close change inspector"
        >
          Close
        </Button>
      </div>

      <div className="space-y-5 p-4">
        <section className={`rounded-xl border p-3 ${style.classes}`}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-bold" aria-hidden="true">
              {style.marker}
            </span>
            <h2 className="text-sm font-semibold text-current">{style.label}</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-300">
            <ChangeSummary change={change} />
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            AS path diff
          </h3>
          <div className="grid gap-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-slate-500">
                <span>Previous</span>
                <span>{formatOrigin(change.previousOrigin)}</span>
              </div>
              <p className="break-words font-mono text-xs leading-5 text-slate-300">
                {change.previousPathDisplay || "No retained path"}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wide text-slate-500">
                <span>Current</span>
                <span>{formatOrigin(change.currentOrigin)}</span>
              </div>
              <p className="break-words font-mono text-xs leading-5 text-slate-100">
                {change.currentPathDisplay || "No active path"}
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <EdgeList title="Added adjacencies" edges={change.addedEdges} tone="add" />
          <EdgeList title="Removed adjacencies" edges={change.removedEdges} tone="remove" />
        </div>

        <section>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            Observation
          </h3>
          <dl className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 text-xs">
            {[
              ["Collector", change.collector],
              ["Peer", change.peer],
              ["Source time", formatAbsolute(change.timestamp)],
              ["Received", formatAbsolute(change.receivedAt)],
              ["Sequence", `#${change.sequence}`],
              ["RIS message", change.messageId || "Not supplied"],
            ].map(([label, value]) => (
              <div key={label} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-3 py-2.5">
                <dt className="text-slate-500">{label}</dt>
                <dd className="min-w-0 break-all text-right font-mono text-slate-300">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </div>
  );
}
