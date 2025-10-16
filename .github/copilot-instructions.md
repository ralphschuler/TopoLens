# TopoLens Copilot Instructions

## Project Overview

TopoLens is a self-contained BGP visualization stack that provides real-time network topology visualization. The project consists of multiple services orchestrated with Docker Compose:

- **GoBGP collector**: Peers with BGP routers to collect routing information
- **Node.js API** (Fastify): Processes BGP data and provides REST/WebSocket endpoints
- **Web frontend** (Vite + TypeScript): Canvas-based visualization with real-time updates
- **SQLite persistence**: Stores routing data and topology information

## Architecture & Project Structure

```
├── api/                    # Backend API service (Node.js + Fastify)
│   ├── src/
│   │   ├── __tests__/     # Vitest unit tests
│   │   ├── app.ts         # Fastify app configuration
│   │   ├── db.ts          # SQLite database operations
│   │   ├── collector.ts   # BGP data collection logic
│   │   ├── index.ts       # Server entry point
│   │   └── types.ts       # TypeScript type definitions
│   └── package.json       # API dependencies & scripts
├── web/                   # Frontend web application (Vite + TypeScript)
│   ├── src/
│   │   ├── __tests__/     # Vitest unit tests
│   │   ├── api.ts         # API client utilities
│   │   ├── canvas.ts      # Canvas rendering & graph layout
│   │   └── main.ts        # Application entry point
│   └── package.json       # Web dependencies & scripts
├── gobgp/                 # GoBGP configuration
├── docker-compose.yml     # Multi-service orchestration
└── .github/workflows/     # CI/CD automation
```

## Development Guidelines

### Code Quality Standards

Both `api/` and `web/` packages maintain identical quality standards:

- **TypeScript**: All code is written in TypeScript with strict typing
- **ESLint**: Code linting with TypeScript ESLint rules (`@typescript-eslint/no-explicit-any` is disabled)
- **Prettier**: Code formatting with project-specific configuration
- **Vitest**: Unit testing framework for both packages

### Required Scripts (Both Packages)

```json
{
  "test": "vitest run",           // Run all tests
  "lint": "eslint --max-warnings=0 \"src/**/*.{ts,tsx}\"",
  "lint:fix": "npm run lint -- --fix",
  "format": "prettier --check \"src/**/*.{ts,tsx,js,json}\"",
  "format:write": "prettier --write \"src/**/*.{ts,tsx,js,json}\""
}
```

### Testing Strategy

- **Unit Tests**: Located in `src/__tests__/` directories
- **Test Framework**: Vitest for both packages
- **Mock Strategy**: Use Vitest's built-in mocking (`vi.mock()`)
- **Database Tests**: Use in-memory SQLite (`:memory:`) for API tests
- **DOM Tests**: Use happy-dom for web frontend tests

### CI/CD Requirements

- **PR Quality Gate**: All tests, linting, and formatting must pass
- **Main Branch Hygiene**: Automatic formatting and linting on main branch
- **Matrix Strategy**: CI runs separately for `api/` and `web/` packages

## Technology-Specific Patterns

### API Service (Fastify + SQLite)

- **Database**: SQLite with WAL mode for persistence
- **WebSocket**: Real-time BGP updates via `@fastify/websocket`
- **Environment**: Supports both demo mode and live BGP peering
- **Error Handling**: Graceful handling of BGP collector failures

Key patterns:
```typescript
// Database operations use WAL mode SQLite
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=WAL");

// Fastify with WebSocket support
const app = Fastify({ logger: true });
await app.register(websocket);
```

### Web Frontend (Canvas + WebSocket)

- **Rendering**: HTML5 Canvas with force-directed graph layout
- **Real-time**: WebSocket connection for live BGP updates  
- **Interaction**: Pan, zoom, and node selection capabilities
- **Performance**: Optimized for large network topologies

Key patterns:
```typescript
// Canvas-based graph visualization
class CanvasGraph {
  private simulate(dt: number) { /* physics simulation */ }
  private draw() { /* canvas rendering */ }
}

// WebSocket integration
connectWS((msg) => {
  if (msg.type === "announce") {
    graph.applyAnnounce(msg.origin_as, msg.as_path);
  }
});
```

### BGP Data Processing

- **RIB Snapshots**: Initial routing table load via `gobgp -j global rib`
- **Live Updates**: Stream processing via `gobgp monitor global updates -j`
- **AS Path Analysis**: Extract topology edges from BGP AS paths
- **Demo Mode**: Synthetic data generation when BGP peer unavailable

## Development Workflow

### Starting Development

1. **Install Dependencies**: `npm install` in both `api/` and `web/`
2. **Environment Setup**: Copy `.env.example` to `.env`, set `DEMO_MODE=true` for development
3. **Development Mode**: 
   - API: `cd api && npm run dev` (tsx watch mode)
   - Web: `cd web && npm run dev` (Vite dev server)
4. **Full Stack**: `docker compose up --build` (production-like environment)

### Testing & Quality

**Before making changes:**
```bash
cd api && npm test && npm run lint && npm run format
cd ../web && npm test && npm run lint && npm run format
```

**Code changes should:**
- Add/update tests first (test-driven development)
- Pass all existing tests without modification
- Follow existing patterns and conventions
- Include proper TypeScript typing
- Handle edge cases and error conditions

### Common Tasks

- **Adding BGP Features**: Extend `collector.ts` and corresponding tests
- **API Endpoints**: Add routes in `app.ts` with proper error handling
- **Visualization Features**: Enhance `canvas.ts` with new rendering capabilities
- **Database Schema**: Update `schema.sql` and migration logic in `db.ts`

## Debugging & Troubleshooting

### Common Issues

- **Empty Visualization**: Enable `DEMO_MODE=true` for development
- **BGP Connection Issues**: Check GoBGP configuration and network reachability
- **Performance Issues**: Consider topology size limits and rendering optimizations
- **WebSocket Disconnections**: Implement reconnection logic and heartbeat monitoring

### Development Tools

- **API Logs**: Fastify provides structured logging
- **Database Inspection**: SQLite CLI tools for data examination
- **Network Analysis**: Browser developer tools for WebSocket monitoring
- **Canvas Debugging**: Browser performance profiling for rendering optimization

## Deployment Considerations

- **Production**: Set `DEMO_MODE=false` and configure real BGP peering
- **Security**: Expose services only on trusted networks
- **Scaling**: Consider AS-level aggregation for large topologies
- **Monitoring**: Add health checks and observability hooks
- **Data Retention**: Implement aging policies for historical data

## File Naming Conventions

- **Tests**: `*.test.ts` in `src/__tests__/` directories
- **Types**: Centralized in `types.ts` files
- **Configuration**: `*.config.*` for tooling configuration
- **Environment**: `.env` for runtime configuration

When implementing new features or fixing issues, ensure compatibility with the existing Docker-based deployment model while maintaining the high standards for code quality and testing coverage.