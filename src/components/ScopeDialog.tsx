import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { RisSubscription } from "../utils/subscription";
import { normalizeRisSubscription, validateRisSubscription } from "../utils/subscription";

const COLLECTOR_EXAMPLES = [
  "rrc00",
  "rrc01",
  "rrc03",
  "rrc04",
  "rrc05",
  "rrc06",
  "rrc07",
  "rrc10",
  "rrc11",
  "rrc12",
  "rrc13",
  "rrc14",
  "rrc15",
  "rrc16",
  "rrc18",
  "rrc19",
  "rrc20",
  "rrc21",
  "rrc22",
  "rrc23",
  "rrc24",
  "rrc25",
  "rrc26",
];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

export interface ScopeDialogProps {
  open: boolean;
  subscription: RisSubscription;
  onApply: (subscription: RisSubscription) => void;
  onClose: () => void;
}

export function ScopeDialog({ open, ...props }: ScopeDialogProps): JSX.Element | null {
  return open ? <ScopeDialogPanel {...props} /> : null;
}

function ScopeDialogPanel({
  subscription,
  onApply,
  onClose,
}: Omit<ScopeDialogProps, "open">): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(subscription);
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    requestAnimationFrame(() => {
      focusableElements(panelRef.current ?? document.body)[0]?.focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRisSubscription(draft);
    const error = validateRisSubscription(normalized);
    if (error) {
      setValidationError(error);
      return;
    }
    onApply(normalized);
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const elements = focusableElements(panelRef.current);
    if (elements.length === 0) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const broadScope = !draft.prefix.trim() && !draft.path.trim();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scope-dialog-title"
        onKeyDown={handleKeyDown}
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl border border-slate-700/70 bg-slate-950 shadow-2xl shadow-black/50 sm:max-w-lg sm:rounded-2xl"
      >
        <form onSubmit={handleSubmit}>
          <header className="flex items-start justify-between gap-4 border-b border-slate-800 px-4 py-4 sm:px-5">
            <div>
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">
                RIS subscription
              </p>
              <h2 id="scope-dialog-title" className="mt-1 text-lg font-semibold text-slate-100">
                Observation scope
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Applying a new scope clears the current baseline and starts a fresh session.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close scope dialog"
            >
              Close
            </Button>
          </header>

          <div className="space-y-5 px-4 py-5 sm:px-5">
            <div className="space-y-2">
              <label
                htmlFor="scope-collector"
                className="block text-xs font-semibold text-slate-200"
              >
                Route collector <span className="text-rose-300">*</span>
              </label>
              <Input
                id="scope-collector"
                list="ripe-collectors"
                autoComplete="off"
                spellCheck={false}
                value={draft.collector}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, collector: event.target.value }))
                }
                placeholder="rrc00"
                className="font-mono"
              />
              <datalist id="ripe-collectors">
                {COLLECTOR_EXAMPLES.map((collector) => (
                  <option value={collector} key={collector} />
                ))}
              </datalist>
              <p className="text-[11px] leading-4 text-slate-500">
                One RIPE collector, for example rrc00 or rrc21.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="scope-prefix" className="block text-xs font-semibold text-slate-200">
                Prefix filter
              </label>
              <Input
                id="scope-prefix"
                autoComplete="off"
                spellCheck={false}
                value={draft.prefix}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prefix: event.target.value }))
                }
                placeholder="203.0.113.0/24 or 2001:db8::/32"
                className="font-mono"
              />
              <p className="text-[11px] leading-4 text-slate-500">
                RIPE also returns more-specific prefixes inside this network.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="scope-path" className="block text-xs font-semibold text-slate-200">
                AS path filter
              </label>
              <Input
                id="scope-path"
                autoComplete="off"
                spellCheck={false}
                value={draft.path}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, path: event.target.value }))
                }
                placeholder="13335 or ^3356,1299"
                className="font-mono"
              />
              <p className="text-[11px] leading-4 text-slate-500">
                A single ASN or a RIPE RIS path expression (not a regular expression).
              </p>
            </div>

            {broadScope && (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3">
                <p className="text-xs font-semibold text-amber-200">Broad collector stream</p>
                <p className="mt-1 text-[11px] leading-4 text-slate-400">
                  With no prefix or path filter, this collector can generate a high update rate. A
                  narrow scope is more stable on phones.
                </p>
              </div>
            )}

            {validationError && (
              <p
                role="alert"
                className="rounded-xl border border-rose-400/25 bg-rose-400/[0.07] p-3 text-xs leading-5 text-rose-200"
              >
                {validationError}
              </p>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-4 sm:px-5">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Apply & restart session</Button>
          </footer>
        </form>
      </div>
    </div>
  );
}
