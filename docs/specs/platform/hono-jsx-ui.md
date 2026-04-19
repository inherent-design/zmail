# Hono JSX UI

## Purpose

This document defines `Hono JSX` as the only HTML rendering layer for zmail
vNext.

## Scope

Covered here:

- server-rendered page and component ownership
- enhanced MPA navigation
- client island boundaries via `hono/jsx/dom`
- typed imperative client calls via Hono RPC and `hc`
- SSE-aware browser runtime behavior

## UI Ownership

Hono JSX owns:

- document and page rendering
- shared layout components
- partial-fragment rendering for enhanced navigation
- server-first form and link semantics
- island mount points and serialized page data

`hono/jsx/dom` owns:

- client-only islands
- local mutation state
- SSE-driven inline refresh behavior
- lightweight progressive enhancement

There is no SPA router in the target contract.

## Canonical UI Tree

The canonical UI tree is:

```txt
server/
  index.tsx
  actions.ts
  ui.tsx
public/
  assets/
    styles.css
  client/
    app.js
    core/
      shell-nav.js
      sync-provider.js
      rpc-client.js
      island-registry.js
    pages/
      *.js
```

Rules:

- page HTML is rendered on the server
- `public/client/app.js` is the only shell entrypoint
- client behavior is split into small page and core modules
- pages without live or imperative behavior must not require route-specific JS
- no legacy `app/**` component or route tree remains in the live runtime

## SSR and Hydration Contract

Default rule:

- every page is server-rendered first
- hydration is opt-in and limited to the smallest possible page module or island
- the browser remains usable with JS disabled except where the interaction is
  inherently imperative

Hydration is allowed for:

- destructive confirmation UX
- inline mutation status
- live status widgets driven by SSE
- enhanced navigation shell behavior

Hydration is not allowed to take ownership of:

- route matching
- organization resolution
- permission checks
- initial page data loading

## Enhanced MPA Navigation Contract

Standard links and GET forms remain canonical.

Progressive enhancement uses:

- request header:
  - `X-Zmail-Partial: main`
- response headers:
  - `X-Zmail-Title`
  - `X-Zmail-Url`
  - `X-Zmail-Page`

Rules:

- server returns only the `#app-main` fragment for partial navigations
- browser swaps `#app-main`, updates `document.title`, and manages history
- View Transitions may be used when available
- failures fall back to normal navigation

## Client Runtime Modules

The minimal browser runtime is split into these modules:

- `shell-nav.js`
  - same-origin enhanced navigation, prefetch, history, partial swaps
- `sync-provider.js`
  - one `EventSource` per tab, topic subscription, reconnect, replay cursor
- `rpc-client.js`
  - typed or convention-driven JSON mutation helpers
- `island-registry.js`
  - page-level lifecycle and cleanup registration

No monolithic UI runtime should accumulate unrelated concerns.

## Data and State Model

Use three tiers:

- server state:
  - loaded by Hono from org-scoped services
- page-local derived state:
  - filter selection, disclosure, destructive confirmation text
- island-local async state:
  - in-flight mutations, transient errors, SSE refresh triggers

Do not mirror auth or organization state in a client store.

## RPC Contract

Imperative mutations use Hono RPC with `hc`.

Rules:

- reads remain HTML-first
- mutations return JSON envelopes
- RPC exports one typed app surface:
  - `export type AppType = typeof app`
- client helpers may wrap `fetch`, but the canonical contract is still the Hono
  route and JSON shape

## Realtime Contract

All live browser updates flow through one authenticated SSE stream per tab.

Rules:

- page modules subscribe only to the topics they need
- SSE is the only realtime transport in vNext
- page modules react to durable runtime events by:
  - refreshing the current fragment
  - or updating local inline status when the cost is lower
- reconnect preserves the last seen event id
- SSE handlers receive the server event name as `eventType`
- page modules filter noisy job events before scheduling refresh work
- running job bursts are debounced, with a max wait to prevent stale views
- terminal job events refresh immediately when relevant to the current page
- focused inputs, textareas, selects, contenteditable regions, and active forms
  defer scheduled refresh until blur or max wait
- fragment refresh preserves replay cursor from `X-Zmail-Event-Cursor` or the
  incoming fragment dataset

## Bundle and Performance Rules

- base shell client bundle target:
  - `<= 15 KB gzip`
- any individual page/island chunk target:
  - `<= 25 KB gzip`
- no monolithic client router or SPA framework
- pages with no interactive behavior should ship only the shared shell bundle

## Out Of Scope

- Ripple or any parallel UI framework on the critical path
- React-specific router or server-action abstractions
- client-owned route trees
- long-lived websocket or WebRTC application transports in v1
