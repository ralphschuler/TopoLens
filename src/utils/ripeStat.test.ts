import { describe, expect, it, vi } from "vitest";

import { lookupAsns } from "./ripeStat";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe("lookupAsns", () => {
  it("returns only ASN suggestions for a Facebook-shaped response", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        status: "ok",
        data: {
          categories: [
            {
              category: "ASNs",
              suggestions: [
                {
                  label: "AS32934",
                  value: "AS32934",
                  description: "FACEBOOK - Facebook, Inc.",
                },
                {
                  label: "AS54115",
                  value: "AS54115",
                  description: "FACEBOOK-CORP - Facebook Inc",
                },
                {
                  label: "AS63293",
                  value: "AS63293",
                  description: "FACEBOOK-OFFNET - Facebook, Inc.",
                },
                {
                  label: "AS149642",
                  value: "AS149642",
                  description: "FACEBOOK-AS - Facebook Singapore Pte Ltd.",
                },
              ],
            },
            {
              category: "Domains",
              suggestions: [
                {
                  label: "facebook.com",
                  value: "facebook.com",
                  description: "A domain result",
                },
              ],
            },
          ],
        },
      }),
    );

    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).resolves.toEqual([
      { asn: 32934, label: "AS32934", description: "FACEBOOK - Facebook, Inc." },
      { asn: 54115, label: "AS54115", description: "FACEBOOK-CORP - Facebook Inc" },
      {
        asn: 63293,
        label: "AS63293",
        description: "FACEBOOK-OFFNET - Facebook, Inc.",
      },
      {
        asn: 149642,
        label: "AS149642",
        description: "FACEBOOK-AS - Facebook Singapore Pte Ltd.",
      },
    ]);
  });

  it("ignores malformed and untrusted category entries", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          categories: [
            null,
            { category: "ASNs", suggestions: "not-an-array" },
            {
              category: "ASNs",
              suggestions: [
                null,
                "AS32934",
                { value: "AS-1", label: "AS-1", description: "negative" },
                { value: "AS4294967296", description: "too large" },
                { value: "<script>alert(1)</script>", description: "markup" },
                {
                  value: "not-an-asn",
                  label: "AS32934",
                  description: "  FACEBOOK\u0000\n  Facebook, Inc.  ",
                },
              ],
            },
          ],
        },
      }),
    );

    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).resolves.toEqual([
      { asn: 32934, label: "AS32934", description: "FACEBOOK Facebook, Inc." },
    ]);
  });

  it("deduplicates ASNs, bounds output, and truncates descriptions", async () => {
    const suggestions = Array.from({ length: 12 }, (_, index) => ({
      value: `AS${64_500 + index}`,
      label: `AS${64_500 + index}`,
      description: `network-${index}-${"x".repeat(400)}`,
    }));
    suggestions.splice(1, 0, {
      value: "AS64500",
      label: "AS64500",
      description: "duplicate",
    });
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ data: { categories: [{ category: "ASNs", suggestions }] } }),
      );

    const result = await lookupAsns("networks", { fetch: fetchImpl });

    expect(result).toHaveLength(8);
    expect(result.map(({ asn }) => asn)).toEqual([
      64500, 64501, 64502, 64503, 64504, 64505, 64506, 64507,
    ]);
    expect(result[0].description).toHaveLength(240);
    expect(result.every(({ label }) => label === `AS${Number(label.slice(2))}`)).toBe(true);
  });

  it("bounds scanning of malformed suggestion collections", async () => {
    const suggestions = Array.from({ length: 64 }, () => ({ value: "not-an-asn" }));
    suggestions.push({ value: "AS32934" });
    const fetchImpl = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        data: { categories: [{ category: "ASNs", suggestions }] },
      }),
    );

    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).resolves.toEqual([]);
  });

  it("trims and URL-encodes the query with a bounded RIPEstat request", async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ data: { categories: [] } }));

    await lookupAsns("  Meta & Facebook  ", { fetch: fetchImpl });

    const [rawUrl, request] = fetchImpl.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.origin + url.pathname).toBe("https://stat.ripe.net/data/searchcomplete/data.json");
    expect(url.searchParams.get("resource")).toBe("Meta & Facebook");
    expect(url.searchParams.get("limit")).toBe("8");
    expect(url.searchParams.get("preferred_version")).toBe("1.0");
    expect(url.searchParams.get("sourceapp")).toBe("topolens");
    expect(String(rawUrl)).toContain("resource=Meta+%26+Facebook");
    expect(request).toMatchObject({ method: "GET" });
  });

  it("throws clear errors for invalid queries and invalid top-level responses", async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();

    await expect(lookupAsns(" x ", { fetch: fetchImpl })).rejects.toThrow(
      "2 to 80 visible characters",
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(jsonResponse({ data: { categories: "invalid" } }));
    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).rejects.toThrow("invalid response");

    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ status: "error", status_code: 500, data: { categories: [] } }),
    );
    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).rejects.toThrow(
      "did not complete successfully",
    );
  });

  it("throws a clear error for HTTP failures", async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ message: "unavailable" }, 503));

    await expect(lookupAsns("Facebook", { fetch: fetchImpl })).rejects.toThrow("HTTP 503");
  });

  it("wraps network failures but passes aborts and the AbortSignal through", async () => {
    const networkFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(lookupAsns("Facebook", { fetch: networkFetch })).rejects.toThrow(
      "network request failed",
    );

    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted", "AbortError");
    const abortingFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(abortError);
    const lookup = lookupAsns("Facebook", {
      fetch: abortingFetch,
      signal: controller.signal,
    });

    await expect(lookup).rejects.toBe(abortError);
    expect(abortingFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
