# Hono Application

## Purpose

This document defines the Hono-owned server surface for zmail vNext.

## Ownership

Hono owns:

- `/healthz`, `/readyz`, and `/metrics`
- `/auth/**`
- `POST /org/**`
- `/rpc/**`
- `/api/**`
- `/ops/health`
- `/ws` WebSocket upgrade and runtime-event delivery

SvelteKit owns browser page `GET` routes and SSR. Production dispatch sends
Hono-owned paths to Hono first, then falls through to SvelteKit.

## Route Groups

Application routes are mounted under configured `base_path` except platform
probe routes, which remain root-level.

Auth and org:

- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `POST /org/select`
- `POST /org/create`
- `POST /org/claim-legacy`

Operational:

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `GET /ops/health`

Command/API:

- `POST /rpc/**`
- `GET|POST /api/**` as explicitly defined by API specs
- `POST /api/finance/imports`
- `POST /api/finance/uploads`

Realtime:

- `GET /ws` with WebSocket upgrade

## Auth Boundary

Browser RPC/API/WebSocket routes use browser session auth and active org
resolution. Bearer machine tokens are rejected for browser command and
WebSocket routes. Finance import APIs may accept org-scoped WorkOS M2M bearer
tokens where specified.

Hono middleware and SvelteKit `hooks.server.ts` share request-neutral browser
principal resolution. Any request touching org data must enter
`runWithOrgContext(orgId, ...)` before accessing SQLite or runtime files.

## Mutation Envelope

Hono mutation routes return the client mutation envelope:

```ts
type ClientMutationEnvelope = {
	ok: true;
	status: string;
	message?: string;
	toast?: { tone: "success" | "warning" | "error"; text: string };
	redirectTo?: string;
	invalidate?: ZmailInvalidationKey[];
	jobs?: Array<{ jobId: string; kind: string; scopeId: string }>;
	events?: Array<{ topic: string; eventType: string; entityId: string }>;
};
```

`ui.targets`, main targets, island targets, node targets, and redirect target
objects are removed from the active contract.

## WebSocket Contract

`/ws` is receive-only for runtime events in phase 1. Clients send:

```ts
type ClientMessage =
	| { type: "subscribe"; topics: string[]; cursor?: number | null }
	| { type: "unsubscribe"; topics: string[] }
	| { type: "ping"; id?: string };
```

The server sends:

```ts
type ServerMessage =
	| { type: "ready"; cursor: number; topics: string[] }
	| { type: "runtime.event"; id: number; event: string; topic: string; data: unknown }
	| { type: "heartbeat"; at: string; cursor: number }
	| { type: "error"; error: string; message?: string }
	| { type: "pong"; id?: string };
```

Rules:

- server validates browser session and active org before upgrade
- server replays durable `runtime_events` newer than cursor with limit `200`
- server sends heartbeat messages every `15s`
- clients reconnect with exponential backoff and last seen cursor
- command-over-WebSocket is out of scope

## Removed Contracts

The active Hono contract does not include:

- `GET /events`
- `X-Zmail-Partial`
- `X-Zmail-Islands`
- `X-Zmail-Nodes`
- `X-Zmail-Event-Cursor`
- Hono JSX browser rendering
- server islands or node partials
- Hono vendor routes for `echarts`, `tslib`, or `zrender`
