export type UpdateKind = "announce" | "withdraw";

/**
 * One ordered AS_PATH segment from RIS Live.
 *
 * An AS_SET is intentionally kept as a set. Treating it as an ordered list
 * would invent routing information that the BGP update does not contain.
 */
export type AsPathSegment = { kind: "asn"; asn: number } | { kind: "as-set"; asns: number[] };

/** A normalized per-prefix RIS Live update. */
export interface RipeUpdate {
  kind: UpdateKind;
  /** Source timestamp converted from RIS seconds to milliseconds. */
  timestamp: number;
  /** Local time at which TopoLens normalized the message. */
  receivedAt: number;
  /** Globally unique RIS message identifier (`data.id`), when supplied. */
  id?: string;
  prefix: string;
  peer: string;
  /** RIS route collector hostname. Messages without one are rejected. */
  collector: string;
  /** Backwards-compatible alias for the collector when RIS supplied a host. */
  host?: string;
  peerAsn?: number;
  /** A single unambiguous origin ASN, or null for no path / an origin AS_SET. */
  originAs: number | null;
  /** The final structured path segment, including an AS_SET when present. */
  origin: AsPathSegment | null;
  nextHop?: string;
  /** Ordered path segments exactly preserving AS_SEQUENCE versus AS_SET. */
  asPath: AsPathSegment[];
  /** Human-readable BGP path, e.g. `64500 {64496,64497}`. */
  asPathDisplay: string;
}

interface RisMessage {
  type?: string;
  data?: {
    timestamp?: unknown;
    peer?: unknown;
    host?: unknown;
    peer_asn?: unknown;
    id?: unknown;
    path?: unknown;
    announcements?: unknown;
    withdrawals?: unknown;
    type?: unknown;
  } & Record<string, unknown>;
}

const MAX_ASN = 4_294_967_295;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function coerceAsn(value: unknown): number | undefined {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return undefined;
  }

  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_ASN ? parsed : undefined;
}

function normalizeAsSet(value: unknown[]): AsPathSegment | undefined {
  if (value.length === 0) return undefined;
  const asns: number[] = [];
  for (const member of value) {
    const asn = coerceAsn(member);
    if (asn === undefined) return undefined;
    asns.push(asn);
  }
  return { kind: "as-set", asns: [...new Set(asns)].sort((left, right) => left - right) };
}

/**
 * Normalize the official `data.path` representation. If any segment is
 * malformed, the whole path becomes unknown instead of bridging across the
 * bad segment and fabricating an AS adjacency.
 */
export function normalizeAsPath(value: unknown): AsPathSegment[] {
  if (!Array.isArray(value)) return [];

  const path: AsPathSegment[] = [];
  for (const rawSegment of value) {
    if (Array.isArray(rawSegment)) {
      const set = normalizeAsSet(rawSegment);
      if (!set) return [];
      path.push(set);
      continue;
    }

    const asn = coerceAsn(rawSegment);
    if (asn === undefined) return [];
    path.push({ kind: "asn", asn });
  }
  return path;
}

/** Format a normalized AS_PATH without losing AS_SET semantics. */
export function formatAsPath(path: readonly AsPathSegment[]): string {
  return path
    .map((segment) =>
      segment.kind === "asn" ? String(segment.asn) : `{${segment.asns.join(",")}}`,
    )
    .join(" ");
}

function cloneSegment(segment: AsPathSegment): AsPathSegment {
  return segment.kind === "asn"
    ? { kind: "asn", asn: segment.asn }
    : { kind: "as-set", asns: [...segment.asns] };
}

function normalizePrefixes(entry: unknown): string[] {
  if (!entry || typeof entry !== "object") return [];
  const candidate = entry as { prefix?: unknown; prefixes?: unknown };
  const prefixes = new Set<string>();

  const single = cleanString(candidate.prefix);
  if (single) prefixes.add(single);

  if (Array.isArray(candidate.prefixes)) {
    for (const value of candidate.prefixes) {
      const prefix = cleanString(value);
      if (prefix) prefixes.add(prefix);
    }
  }
  return [...prefixes];
}

function normalizeWithdrawals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const prefixes = new Set<string>();

  for (const entry of value) {
    const direct = cleanString(entry);
    if (direct) {
      prefixes.add(direct);
      continue;
    }

    for (const prefix of normalizePrefixes(entry)) {
      prefixes.add(prefix);
    }
  }
  return [...prefixes];
}

function normalizeTimestampSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Expand a RIS Live envelope into one normalized update per prefix.
 *
 * The implementation follows the official schema: AS path attributes live at
 * `data.path`, announcement prefixes at `announcement.prefixes`, next-hop at
 * `announcement.next_hop`, and withdrawals at `data.withdrawals`.
 */
export function extractUpdates(raw: unknown): RipeUpdate[] {
  if (!raw || typeof raw !== "object") return [];
  const message = raw as RisMessage;
  if (message.type !== "ris_message" || !message.data) return [];

  const data = message.data;
  // Missing type is tolerated for old fixtures/recordings, but another
  // explicit RIS subtype must never be interpreted as a route update.
  if (data.type !== undefined && data.type !== "UPDATE") return [];

  const receivedAt = Date.now();
  const timestampSeconds = normalizeTimestampSeconds(data.timestamp);
  const timestampCandidate =
    timestampSeconds === undefined ? receivedAt : Math.round(timestampSeconds * 1_000);
  const timestamp =
    Number.isFinite(timestampCandidate) && Math.abs(timestampCandidate) <= MAX_DATE_MILLISECONDS
      ? timestampCandidate
      : receivedAt;
  const peer = cleanString(data.peer);
  const host = cleanString(data.host);
  // Route identity is collector + peer + prefix. Accepting a missing source
  // would merge unrelated routes and could let a withdrawal remove the wrong
  // baseline, so malformed source identities are discarded.
  if (!peer || !host) return [];
  const collector = host;
  const id = cleanString(data.id);
  const peerAsn = coerceAsn(data.peer_asn);
  const normalizedPath = normalizeAsPath(data.path);
  const updates: RipeUpdate[] = [];

  const announcements = Array.isArray(data.announcements) ? data.announcements : [];
  for (const announcement of announcements) {
    const prefixes = normalizePrefixes(announcement);
    const nextHop =
      announcement && typeof announcement === "object"
        ? cleanString((announcement as { next_hop?: unknown }).next_hop)
        : undefined;

    for (const prefix of prefixes) {
      const asPath = normalizedPath.map(cloneSegment);
      const origin = asPath.length > 0 ? cloneSegment(asPath[asPath.length - 1]) : null;
      updates.push({
        kind: "announce",
        timestamp,
        receivedAt,
        id,
        prefix,
        peer,
        collector,
        host,
        peerAsn,
        originAs: origin?.kind === "asn" ? origin.asn : null,
        origin,
        nextHop,
        asPath,
        asPathDisplay: formatAsPath(asPath),
      });
    }
  }

  for (const prefix of normalizeWithdrawals(data.withdrawals)) {
    updates.push({
      kind: "withdraw",
      timestamp,
      receivedAt,
      id,
      prefix,
      peer,
      collector,
      host,
      peerAsn,
      originAs: null,
      origin: null,
      asPath: [],
      asPathDisplay: "",
    });
  }

  return updates;
}
