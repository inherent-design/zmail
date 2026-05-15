# SvelteKit UI

## Purpose

This document defines the active browser UI target for zmail vNext.

## Ownership

SvelteKit owns browser page `GET` routes, SSR, layouts, route loads, and client
navigation. Hono remains the security and command boundary for auth redirects,
org POST routes, `/rpc/**`, `/api/**`, health, readiness, metrics, and `/ws`.

Production runs one Node process:

1. dispatch Hono-owned paths first
2. upgrade `/ws` through Hono WebSocket support
3. fall through remaining browser page requests to SvelteKit `build/handler.js`

Development runs the Hono API/WebSocket server plus the SvelteKit dev server.
The SvelteKit dev server proxies Hono-owned paths.

## Routes

SvelteKit route files live under `src/routes/**`.

Required browser pages:

- `/`
- `/accounts`
- `/accounts/new`
- `/accounts/[accountId]`
- `/accounts/[accountId]/reconnect`
- `/accounts/[accountId]/delete`
- `/messages`
- `/messages/[messageId]`
- `/review`
- `/finance`
- `/runs`
- `/profiles/[accountId]`
- `/org/select`
- `/org/create`
- `/org/claim-legacy`

Route loads must resolve org context through `src/hooks.server.ts` before
calling existing domain loaders. Loads declare cache dependencies with
`depends(...)` using `ZmailInvalidationKey`.

## Mutation Contract

Browser domain writes call Hono mutation routes. SvelteKit form actions are not
used for domain writes in this migration.

Mutation routes return:

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

`ui.targets`, main fragments, island fragments, node partials, and
`data-zmail-*` island/node attributes are not active contracts.

## Realtime

The browser connects to `/ws` after page load and sends a `subscribe` message
with topics and an optional cursor. The server replays durable runtime events
newer than the cursor with limit `200`, then streams new events and heartbeat
messages every 15 seconds.

Client behavior:

- keep the last seen cursor in browser state
- reconnect with exponential backoff
- map runtime event topics to SvelteKit invalidation keys
- never send mutation commands over WebSocket in phase 1

## Components

Reusable browser components live under `src/lib/components/**`. Client helpers
live under `src/lib/client/**`; shared wire validation lives in
`lib/client-contract.ts` so server tests and browser code use one schema.
