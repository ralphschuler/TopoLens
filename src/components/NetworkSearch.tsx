import { useEffect, useRef, useState, type FormEvent } from "react";

import { lookupAsns, type AsnSuggestion } from "../utils/ripeStat";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface NetworkSearchProps {
  collector: string;
  onWatch: (suggestion: AsnSuggestion) => void;
}

type SearchState = "idle" | "loading" | "success" | "error";

export function NetworkSearch({ collector, onWatch }: NetworkSearchProps): JSX.Element {
  const requestRef = useRef<AbortController | null>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<AsnSuggestion[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [error, setError] = useState("");

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    const query = term.trim();
    if (query.length < 2) return;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSearchState("loading");
    setError("");
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    try {
      const matches = await lookupAsns(query, { signal: controller.signal });
      if (requestRef.current !== controller || (controller.signal.aborted && !timedOut)) return;
      if (timedOut) throw new Error("RIPEstat lookup timed out.");
      setResults(matches);
      setSearchState("success");
    } catch (lookupError) {
      if (requestRef.current !== controller || (controller.signal.aborted && !timedOut)) return;
      setResults([]);
      setSearchState("error");
      setError(
        timedOut
          ? "RIPEstat lookup timed out."
          : lookupError instanceof Error
            ? lookupError.message
            : "RIPEstat could not resolve this network name.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
    }
  };

  return (
    <section className="topology-panel p-2.5 sm:p-3" aria-labelledby="network-search-title">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-1">
        <div>
          <h2 id="network-search-title" className="text-sm font-semibold text-slate-100">
            Find a network by name
          </h2>
          <p id="network-search-help" className="mt-1 text-[10px] leading-4 text-slate-500">
            Search RIPEstat for a company or network, then watch announcements originated by its
            ASN.
          </p>
        </div>
        <span className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-slate-500">
          collector {collector}
        </span>
      </div>

      <form
        className="mt-3 grid gap-2 sm:grid-cols-[minmax(220px,1fr)_auto]"
        onSubmit={handleSearch}
      >
        <Input
          type="search"
          value={term}
          onChange={(event) => {
            requestRef.current?.abort();
            requestRef.current = null;
            setTerm(event.target.value);
            if (searchState !== "idle") {
              setSearchState("idle");
              setResults([]);
              setError("");
            }
          }}
          placeholder="Facebook, Cloudflare, Netflix…"
          aria-label="Find network by name or ASN"
          aria-describedby="network-search-help"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
        />
        <Button type="submit" disabled={term.trim().length < 2 || searchState === "loading"}>
          {searchState === "loading" ? "Searching…" : "Search ASN"}
        </Button>
      </form>

      <div className="mt-2">
        {searchState === "loading" && (
          <p role="status" className="px-1 text-[11px] text-cyan-200">
            Looking up matching autonomous systems…
          </p>
        )}
        {searchState === "error" && (
          <p
            role="alert"
            className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] p-3 text-xs leading-5 text-rose-200"
          >
            {error} You can still enter an ASN manually under Scope.
          </p>
        )}
        {searchState === "success" && results.length === 0 && (
          <p
            role="status"
            className="rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-400"
          >
            No ASN matches found. Try the registered network name or enter the ASN under Scope.
          </p>
        )}
        {searchState === "success" && results.length > 0 && (
          <p role="status" className="sr-only">
            {results.length} autonomous system {results.length === 1 ? "match" : "matches"} found.
          </p>
        )}
      </div>

      {results.length > 0 && (
        <ul className="mt-2 grid gap-2 lg:grid-cols-2" aria-label="Autonomous system matches">
          {results.map((result) => (
            <li
              key={result.asn}
              className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/80 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs font-bold text-cyan-200">{result.label}</p>
                <p className="mt-1 break-words text-[11px] leading-4 text-slate-400">
                  {result.description || "Registered autonomous system"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => onWatch(result)}
                aria-label={`Watch origin announcements for ${result.label}${result.description ? `, ${result.description}` : ""}`}
              >
                Watch origin
              </Button>
            </li>
          ))}
        </ul>
      )}

      {results.length > 0 && (
        <p className="mt-2 px-1 text-[10px] leading-4 text-amber-200/80">
          Watching an origin starts a fresh session and clears any existing prefix filter. Registry
          names can be ambiguous, so choose the ASN you intend to inspect. Standalone withdrawals
          usually have no AS path to match and may not appear in this origin-scoped view.
        </p>
      )}
    </section>
  );
}
