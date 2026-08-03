# TopoLens Agent Guidelines

## Product contract

TopoLens is a static, browser-only Vite + React + TypeScript application for observing session-based RIPE RIS Live topology changes. It is designed for network engineers and curious operators on mobile and desktop. Do not introduce server-side collection, processing, persistence, container orchestration, a synthetic demo feed, authentication, or persistent route history unless the product scope is explicitly changed.

The application does not load a RIB snapshot. Never label session data as the current or complete internet topology. The UI and documentation must retain explicit **warming** and **partial** semantics.

## Repository shape

- Work from the repository root; this is a single-package application.
- Application code lives under `src/`.
- RIPE parsing and subscription utilities live under `src/utils/`.
- Stateful topology logic lives under `src/topology/`.
- Fetching and graph computation use modules under `src/workers/`.
- GitHub Actions workflows live under `.github/workflows/`.
- `dist/` is generated output. Do not hand-edit it.

## Required workflow

Use Node.js 22 and install the locked dependency graph with `npm ci`. Before handing off a change, run every root quality script:

```bash
npm run typecheck
npm run lint
npm run format
npm run test
npm run build
```

Do not use lint or formatting autofix in CI. Format locally and commit the resulting source changes intentionally. Add or update tests before production code when practical, and do not weaken an assertion merely to make a failing behavior pass.

## Data-truth invariants

- Normalize one update per prefix and preserve RIPE source timestamp separately from local receive time.
- Key route state by `collector + peer + prefix`; do not merge observations from different collectors or peers.
- Treat a session's first announcement as `first-observed`, not as proof of a new global announcement.
- Compare later announcements with the last retained route state. Classify origin changes once rather than also double-counting them as path changes.
- Ignore identical announcements as topology changes while still refreshing the route's last-observed metadata.
- A known withdrawal removes the retained route and its known edges. An unmatched withdrawal is `withdrawal-observed` and must not fabricate a previous path or removed edges.
- Preserve AS sets as unordered sets. Do not invent adjacency through an AS set or malformed path segment.
- Remove AS-prepending self loops from graph edges, but preserve the original normalized path for inspection.
- A reconnect cannot repair the observation gap. Scope changes must begin a clean session baseline.
- Keep route, change, update-batch, and graph buffers bounded. Surface eviction/drop counters whenever retained data is smaller than all-session counts.

## UI and accessibility

- Build mobile-first. Core subscription, feed, graph, inspector, reconnect, and clear/reset flows must work at narrow phone widths without horizontal page overflow.
- Use touch targets of at least 44 × 44 CSS pixels for primary interactive controls.
- Do not make hover the only way to inspect a change or graph element. Support tap/click and keyboard use.
- Preserve visible focus, semantic controls, labels, dialogs/drawers with dismiss actions, and meaningful live status text.
- Keep connection state separate from data-completeness state. `connected` does not mean `complete`.
- Prefer compact, information-dense UI suitable for technical users, but explain ambiguous BGP terms in context.
- Avoid doing parsing, unbounded array copies, or graph layout work synchronously in the React render path.

## Scope filters

- Validate collectors in RIPE `rrcNN` form, prefixes as IPv4/IPv6 CIDR, and path filters as supported ASNs or RIS expressions.
- Build the server-side RIS subscription from normalized values; never interpolate user input into executable code.
- Blank prefix/path values mean broad scope and should be presented as potentially high volume.
- Applying a new subscription must reset incompatible route state, feed history, selection, and graph state together.

## Tests

At minimum, preserve coverage for:

- official RIS message shapes, multiple prefixes, withdrawals, missing attributes, malformed paths, and AS sets;
- subscription normalization, validation, and exact WebSocket payloads;
- first observation, identical update, non-topological attribute update, path change, origin change, known withdrawal, unmatched withdrawal, and batch order;
- collector/peer/prefix route-key separation;
- exact added/removed AS edges, prepending, uncertain adjacency, bounded retention, counters, clear/reset, and defensive snapshots;
- worker reconnect/batching behavior when changed;
- responsive and accessible user flows when component behavior changes.

Do not write tests that depend on a particular live RIS event occurring. Mock protocol boundaries and use deterministic fixtures for automated tests; use the public feed only for manual smoke testing.

## Deployment

GitHub Pages is the production target. Keep the app static and respect Vite's `BASE_PATH` so project Pages and custom-domain deployments both resolve assets correctly. Pages may deploy only after the same root typecheck, lint, format, test, and build gate used for pull requests has passed.
