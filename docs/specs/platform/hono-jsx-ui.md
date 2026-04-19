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
- hydration is opt-in and limited to the smallest possible page module or
  page-owned island
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

## Page Classes

Every browser page declares one page class:

| Page | Class | Notes |
| ---- | ----- | ----- |
| `home` | `hybrid` | Server-rendered summary with live job and account refresh hooks. |
| `accounts` | `hybrid` | Server-rendered lists and forms with RPC lifecycle actions. |
| `messages` | `static` | Server-rendered list first; hybrid behavior may be added later. |
| `message-detail` | `hybrid` | Server-rendered document view with classification action hooks. |
| `review` | `hybrid` | Server-rendered queue with RPC resolution controls. |
| `finance` | `hybrid` | Server-rendered analytics islands with chart enhancement. |
| `runs` | `hybrid` | Server-rendered operational table with live job refresh hooks. |
| future deeply interactive pages | `dynamic-root` | Client-owned root allowed only when page-owned islands are too coarse. |

```ts
type PageMode = "static" | "hybrid" | "dynamic-root";
```

Class rules:

- `static` pages ship no route-specific JavaScript.
- `hybrid` pages use server-rendered HTML and page-owned islands for targeted
  enhancement.
- `dynamic-root` pages may hand a root to client code, but auth, org
  resolution, and first render still stay server-owned.

## Page-Owned Islands

A page-owned island is the canonical targeted swap unit. It is route-scoped,
stable across renders, and owned by the page that renders it. Full page partial
swaps remain available for navigation and broad refreshes, but live updates and
intra-page actions should refresh affected island roots first.

```ts
type IslandStatePolicy = {
  semanticUrlKeys: string[];
  sessionKeys: string[];
  ephemeralKeys: string[];
  restoreOnSwap: boolean;
  shareable: "none" | "committed" | "live";
};

type IslandDefinition = {
  id: string;
  page: string;
  mode: "server" | "client" | "dynamic-root";
  fragmentUrl: string;
  topics: string[];
  statePolicy: IslandStatePolicy;
};

type IslandModule = {
  init(ctx: IslandContext): void | (() => void);
  beforeSwap?(): unknown;
  afterSwap?(state: unknown): void;
  shouldRefresh?(event: RuntimeEvent): boolean;
};
```

DOM contract:

- island root: `data-zmail-island="finance.cashflow"`
- island mode: `data-zmail-island-mode="server|client|dynamic-root"`
- island props:
  `<script type="application/json" data-zmail-island-props="finance.cashflow">...</script>`
- optional document state scope:
  `data-zmail-state-scope="<opaque-org-runtime-scope>"`

State policy:

- semantic URL state is committed, shareable state such as `tab`, `year`,
  `accountId`, `institutionId`, `ownerIdentityId`, `sourceKind`, committed
  chart ranges, and committed drilldowns
- session-restored interaction state includes chart zoom before commit, visible
  series, table sort, scroll position, expanded rows, and active subpanels
- ephemeral runtime state includes hover, brush drag, crosshair, focused input,
  and pending RPC state
- server state includes records, rollups, runtime event cursor, job status, and
  finance materializations
- swap restore must exclude ephemeral keys

## Enhanced MPA Navigation Contract

Standard links and GET forms remain canonical.

Progressive enhancement uses:

- request header:
  - `X-Zmail-Partial: main`
  - `X-Zmail-Partial: islands`
  - `X-Zmail-Islands: finance.summary,finance.cashflow`
- response headers:
  - `X-Zmail-Title`
  - `X-Zmail-Url`
  - `X-Zmail-Page`
  - `X-Zmail-Event-Cursor`
  - `X-Zmail-Islands`

Rules:

- server returns only the `#app-main` fragment for partial navigations
- server returns only requested island fragment templates for island refreshes
- browser swaps `#app-main`, updates `document.title`, and manages history
- browser swaps matching island roots, restores session state, and remounts only
  changed island modules
- missing or unsupported island responses may fall back to a main refresh for
  the same page only
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
  - page-level and island-level lifecycle and cleanup registration

No monolithic UI runtime should accumulate unrelated concerns.

Finance chart modules may import ECharts through the document import map. The
active implementation maps `echarts/`, `tslib`, and `zrender/` to Hono-served
vendor asset routes.

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
  - refreshing affected island or islands
  - falling back to the current page main fragment only when required
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
- scheduled SSE refresh captures origin page, URL, and requested island ids
- if the page or URL changes before a scheduled refresh executes, the browser
  drops the refresh
- user navigation always wins over scheduled refresh
- runtime event payloads may include change hints:

```ts
type RuntimeEventPayload = {
  changeHints?: {
    islands?: string[];
    entities?: Array<{ kind: string; id: string }>;
  };
};
```

Initial publishers do not need to emit `changeHints`; page modules may map
topics and event names to islands. Retargeting a stale event to another safe
page is a future extension, not part of the first island implementation.

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
