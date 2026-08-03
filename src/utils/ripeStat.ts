const SEARCH_ENDPOINT = "https://stat.ripe.net/data/searchcomplete/data.json";
const RESULT_LIMIT = 8;
const MAX_ASN = 4_294_967_295;
const MAX_QUERY_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_CATEGORIES_TO_SCAN = 32;
const MAX_SUGGESTIONS_TO_SCAN = 64;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\p{Cc}\p{Cf}]+/gu;

export interface AsnSuggestion {
  asn: number;
  label: string;
  description: string;
}

export interface LookupAsnsOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuery(query: string): string {
  if (typeof query !== "string") {
    throw new TypeError("ASN search query must be a string.");
  }

  const normalized = query.trim();
  const characters = [...normalized];
  const visibleCharacters = characters.filter(
    (character) => !/\s/u.test(character) && !CONTROL_CHARACTERS.test(character),
  ).length;

  if (
    visibleCharacters < 2 ||
    characters.length > MAX_QUERY_LENGTH ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    throw new RangeError("ASN search query must contain 2 to 80 visible characters.");
  }

  return normalized;
}

function parseAsn(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const match = /^AS(0|[1-9]\d*)$/iu.exec(value.trim());
  if (!match) return undefined;

  const asn = Number(match[1]);
  return Number.isSafeInteger(asn) && asn <= MAX_ASN ? asn : undefined;
}

function cleanDescription(value: unknown): string {
  if (typeof value !== "string") return "";

  // Bound work on untrusted API text before normalizing it for compact UI use.
  const boundedInput = value.slice(0, MAX_DESCRIPTION_LENGTH * 4);
  const cleaned = boundedInput.replace(CONTROL_CHARACTERS_GLOBAL, " ").replace(/\s+/gu, " ").trim();
  return [...cleaned].slice(0, MAX_DESCRIPTION_LENGTH).join("");
}

function parseSuggestions(payload: unknown): AsnSuggestion[] {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.categories)) {
    throw new Error("RIPEstat ASN lookup returned an invalid response.");
  }
  if (
    (payload.status !== undefined && payload.status !== "ok") ||
    (payload.status_code !== undefined && payload.status_code !== 200)
  ) {
    throw new Error("RIPEstat ASN lookup did not complete successfully.");
  }

  const suggestions: AsnSuggestion[] = [];
  const seenAsns = new Set<number>();

  for (const category of payload.data.categories.slice(0, MAX_CATEGORIES_TO_SCAN)) {
    if (
      !isRecord(category) ||
      category.category !== "ASNs" ||
      !Array.isArray(category.suggestions)
    ) {
      continue;
    }

    for (const entry of category.suggestions.slice(0, MAX_SUGGESTIONS_TO_SCAN)) {
      if (!isRecord(entry)) continue;
      const asn = parseAsn(entry.value) ?? parseAsn(entry.label);
      if (asn === undefined || seenAsns.has(asn)) continue;

      seenAsns.add(asn);
      suggestions.push({
        asn,
        label: `AS${asn}`,
        description: cleanDescription(entry.description),
      });

      if (suggestions.length === RESULT_LIMIT) return suggestions;
    }
  }

  return suggestions;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

/** Look up company/network names as canonical ASN suggestions via RIPEstat. */
export async function lookupAsns(
  query: string,
  options: LookupAsnsOptions = {},
): Promise<AsnSuggestion[]> {
  const normalizedQuery = normalizeQuery(query);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("RIPEstat ASN lookup failed: Fetch is unavailable.");
  }

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("resource", normalizedQuery);
  url.searchParams.set("limit", String(RESULT_LIMIT));
  url.searchParams.set("preferred_version", "1.0");
  url.searchParams.set("sourceapp", "topolens");

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    throw new Error("RIPEstat ASN lookup failed: network request failed.", { cause: error });
  }

  if (!response.ok) {
    throw new Error(`RIPEstat ASN lookup failed with HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    throw new Error("RIPEstat ASN lookup returned an invalid response.", { cause: error });
  }

  return parseSuggestions(payload);
}
