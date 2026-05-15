# ADR 002: SvelteKit UI and Hono WebSocket

## Status

Accepted.

## Decision

zmail vNext uses:

- SvelteKit for browser page routes, SSR, client navigation, and component UI
- Hono for auth redirects, org POST routes, `/rpc/**`, `/api/**`, health,
  readiness, metrics, and `/ws`
- a single production Node dispatcher that routes Hono-owned paths first and
  falls through to SvelteKit
- durable SQLite `runtime_events` delivered to browsers over WebSocket

## Rationale

- SvelteKit removes custom enhanced MPA navigation, page islands, and node
  partial refresh contracts
- Vite bundles browser dependencies instead of Hono vendor routes
- Hono stays the explicit command/API security boundary
- WebSocket replay keeps the durable runtime event model while replacing SSE
  with bidirectional-capable transport for future phases

## Consequences

- `GET /events` is removed
- `X-Zmail-Partial`, `X-Zmail-Islands`, `X-Zmail-Nodes`, and
  `X-Zmail-Event-Cursor` are removed
- `ui.targets` is replaced by `invalidate` keys and `redirectTo`
- browser tests use roles, labels, and `data-testid` instead of island/node
  selectors
- SvelteKit route loads must use `depends(...)` keys for realtime invalidation

## Out Of Scope

- command-over-WebSocket
- full SPA-only deployment
- SEO-focused public pages
