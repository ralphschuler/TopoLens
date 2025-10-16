export type UpdateKind = "announce" | "withdraw";

export interface RipeUpdate {
  kind: UpdateKind;
  timestamp: number;
  receivedAt: number;
  prefix: string;
  peer: string;
  host?: string;
  peerAsn?: number;
  originAs?: number | null;
  nextHop?: string;
  asPath?: string;
}

interface RisMessage {
  type?: string;
  data?: {
    timestamp?: number;
    peer?: string;
    host?: string;
    peer_asn?: number | string;
    origin_asn?: number | string;
    announcements?: unknown;
    withdrawals?: unknown;
    type?: string;
  } & Record<string, unknown>;
}

function normalizePrefixes(entry: any): string[] {
  const prefixes = new Set<string>();
  if (typeof entry?.prefix === "string") {
    prefixes.add(entry.prefix);
  }
  if (Array.isArray(entry?.prefixes)) {
    for (const prefix of entry.prefixes) {
      if (typeof prefix === "string") {
        prefixes.add(prefix);
      }
    }
  }
  return [...prefixes];
}

function normalizeAsPath(entry: any): string | undefined {
  const values = Array.isArray(entry?.as_path) ? entry.as_path : entry?.as_path?.value;
  if (!Array.isArray(values)) return undefined;
  const parts = values
    .map((part) => (typeof part === "number" || typeof part === "string" ? String(part) : null))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function inferOriginAs(entry: any): number | null {
  if (typeof entry?.origin === "number") return entry.origin;
  const path = Array.isArray(entry?.as_path) ? entry.as_path : [];
  const last = path.length > 0 ? path[path.length - 1] : undefined;
  const asn = typeof last === "number" ? last : Number.parseInt(String(last ?? ""), 10);
  return Number.isFinite(asn) ? asn : null;
}

function coerceAsn(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function extractUpdates(raw: unknown): RipeUpdate[] {
  if (!raw || typeof raw !== "object") return [];
  const message = raw as RisMessage;
  if (message.type !== "ris_message" || !message.data) return [];
  const data = message.data;
  const timestampSeconds = typeof data.timestamp === "number" ? data.timestamp : undefined;
  const baseTimestamp = timestampSeconds ? Math.round(timestampSeconds * 1000) : Date.now();
  const receivedAt = Date.now();
  const peer = typeof data.peer === "string" ? data.peer : "unknown";
  const host = typeof data.host === "string" ? data.host : undefined;
  const peerAsn = coerceAsn(data.peer_asn);
  const originAsData = coerceAsn(data.origin_asn);

  const updates: RipeUpdate[] = [];

  const announcements = Array.isArray(data.announcements) ? data.announcements : [];
  for (const announcement of announcements) {
    const prefixes = normalizePrefixes(announcement);
    const nextHop = typeof (announcement as any)?.next_hop === "string" ? (announcement as any).next_hop : undefined;
    const asPath = normalizeAsPath(announcement);
    const originAs = inferOriginAs(announcement) ?? originAsData ?? null;
    for (const prefix of prefixes) {
      updates.push({
        kind: "announce",
        timestamp: baseTimestamp,
        receivedAt,
        prefix,
        peer,
        host,
        peerAsn,
        originAs,
        nextHop,
        asPath,
      });
    }
  }

  const withdrawals = Array.isArray(data.withdrawals) ? data.withdrawals : [];
  for (const entry of withdrawals) {
    const prefix =
      typeof entry === "string"
        ? entry
        : typeof (entry as any)?.prefix === "string"
          ? (entry as any).prefix
          : undefined;
    if (!prefix) continue;
    updates.push({
      kind: "withdraw",
      timestamp: baseTimestamp,
      receivedAt,
      prefix,
      peer,
      host,
      peerAsn,
      originAs: originAsData ?? null,
    });
  }

  return updates;
}
