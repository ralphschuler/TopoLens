# TopoLens

TopoLens is now a static web application built with [Vite](https://vitejs.dev/) that visualises live BGP activity using the [RIPE RIS Live](https://ris-live.ripe.net/) WebSocket feed. The browser stores every update locally in IndexedDB so you can reconnect or refresh without losing the most recent announcements.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL (usually `http://localhost:5173`) in your browser. The app automatically subscribes to updates from `rrc00.ripe.net`.

### Production build

```bash
npm run build
npm run preview
```

## How it works

* A WebSocket connection is opened to `wss://ris-live.ripe.net/v1/ws/` and the app subscribes to the `rrc00.ripe.net` stream.
* Incoming messages are normalised into announcement and withdrawal records.
* Updates are persisted in IndexedDB so that the most recent entries remain available between refreshes.
* The UI presents the latest events with key metadata such as AS path, peer, origin AS, and next hop when available.

## Testing

The project uses [Vitest](https://vitest.dev/) for unit tests.

```bash
npm test
```

## License

MIT
