import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkSearch } from "./NetworkSearch";

const mocks = vi.hoisted(() => ({
  lookupAsns: vi.fn(),
}));

vi.mock("../utils/ripeStat", () => ({
  lookupAsns: mocks.lookupAsns,
}));

interface MountedSearch {
  container: HTMLDivElement;
  root: Root;
}

const mountedSearches: MountedSearch[] = [];

function enterText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTML input value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent)?.trim() === name,
  );
  if (!button) throw new Error(`Could not find button named ${name}`);
  return button;
}

async function renderSearch(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedSearches.push({ container, root });

  await act(async () => {
    root.render(<NetworkSearch collector="rrc00" onWatch={vi.fn()} />);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  while (mountedSearches.length > 0) {
    const mounted = mountedSearches.pop();
    if (!mounted) continue;
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  vi.clearAllMocks();
});

describe("NetworkSearch", () => {
  it("aborts an in-flight lookup when the query changes", async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveRequest: ((value: unknown[]) => void) | undefined;
    mocks.lookupAsns.mockImplementation((_query: string, options: { signal?: AbortSignal }) => {
      requestSignal = options.signal;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    });
    await renderSearch();

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Find network by name or ASN"]',
    );
    expect(input).not.toBeNull();
    await act(async () => enterText(input!, "Facebook"));
    await act(async () => buttonNamed("Search ASN").click());

    expect(requestSignal?.aborted).toBe(false);
    await act(async () => enterText(input!, "Cloudflare"));
    expect(requestSignal?.aborted).toBe(true);

    await act(async () => {
      resolveRequest?.([
        { asn: 32934, label: "AS32934", description: "FACEBOOK - Facebook, Inc." },
      ]);
      await Promise.resolve();
    });
    expect(document.querySelector('[aria-label="Autonomous system matches"]')).toBeNull();
  });

  it("keeps manual scope available when RIPEstat fails", async () => {
    mocks.lookupAsns.mockRejectedValue(new Error("RIPEstat ASN lookup failed with HTTP 503."));
    await renderSearch();

    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Find network by name or ASN"]',
    );
    await act(async () => enterText(input!, "Facebook"));
    await act(async () => {
      buttonNamed("Search ASN").click();
      await Promise.resolve();
    });

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("HTTP 503");
    expect(alert?.textContent).toContain("enter an ASN manually under Scope");
    expect(input?.disabled).toBe(false);
  });
});
