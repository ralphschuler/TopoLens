import { useMemo } from "react";
import { useRipeRis } from "./hooks/useRipeRis";
import type { PersistedUpdate } from "./db/indexedDb";

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
      <section className="panel">
        <header className="status-bar">
          <h1>TopoLens</h1>
          <span className="status-pill" data-state={status}>
            {statusLabel}
          </span>
        </header>
        <p>
          Streaming live BGP announcements from the
          {" "}
          <a href="https://ris-live.ripe.net/" target="_blank" rel="noreferrer">
            RIPE RIS Live API
          </a>
          . Updates are persisted locally using your browser&apos;s IndexedDB for replay.
        </p>
        <div className="controls">
          <button className="secondary" type="button" onClick={reconnect}>
            Reconnect
          </button>
          <button className="secondary" type="button" onClick={clearHistory}>
            Clear stored updates
          </button>
        </div>
        {error && <p style={{ color: "#fca5a5", marginTop: "0.75rem" }}>{error}</p>}
      </section>

      <section className="panel">
        <h2>Recent updates</h2>
        {updates.length === 0 ? (
          <div className="empty-state">Waiting for live data…</div>
        ) : (
          <ul className="updates-list">
            {updates.map((update) => (
              <UpdateRow update={update} key={update.id ?? `${update.prefix}-${update.timestamp}-${update.kind}`} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
