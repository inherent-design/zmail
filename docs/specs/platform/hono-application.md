# Hono Application

## Purpose

This document defines the Hono application as the only server/runtime entrypoint
for zmail vNext.

## Scope

Covered here:

- route ownership
- middleware order
- request lifecycle
- error handling
- JSON API conventions
- browser page rendering responsibility
- SSE contract
- partial-navigation contract

Not covered here:

- Gmail domain semantics
- message or finance schemas
- worker internals beyond the Hono boundary

## Application Ownership

Hono owns:

- all HTTP routing
- all auth/session resolution
- all organization resolution
- all browser page GET and POST handlers
- all external JSON API routes
- all redirect and error response behavior

No TanStack router, file-route generator, or server-action layer remains in the
target architecture.

The old `app/**` route/component tree has been purged. Live route ownership now
resides directly in `server/index.tsx`, with data-loading and command glue in
`server/actions.ts`.

Server bootstrap configuration comes from:

- non-secret runtime config in `zmail.toml`
- environment overrides
- repo-managed secrets in `secrets.enc.yaml` loaded natively by `mise` for
  local server-side tasks
- runtime env injection for hosted deployments

Browser assets never consume secret bootstrap values directly.

Internal application taxonomy is defined separately in
[`internal-application-taxonomy.md`](./internal-application-taxonomy.md). Hono
remains the transport owner; the taxonomy governs how read, write, and
domain-focused application logic should be named and separated over time.

## Route Groups

Application routes are mounted under the configured `base_path`.

The route examples below are app-relative. With the default `base_path = "/"`,
they resolve exactly as written. With `base_path = "/zmail"`, the effective
paths become `/zmail/...`.

`/healthz`, `/readyz`, and `/metrics` stay root-level. `/metrics` is disabled
unless observability config explicitly enables it.

### Auth and org routes

- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /org/select`
- `POST /org/select`
- `GET /org/create`
- `POST /org/create`
- `GET /org/claim-legacy`
- `POST /org/claim-legacy`

### Operational routes

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`
- `GET /ops/health`

`/healthz` and `/readyz` are reserved for platform probes. They must stay
unauthenticated, return minimal JSON, and avoid org-scoped storage access.
`/metrics` is unauthenticated only when explicitly enabled and must use
normalized route labels. `/ops/health` is an authenticated browser route that
requires an active org and `org_operator` or higher.

### Browser page routes

- `GET /`
- `GET /accounts`
- `GET /accounts/new`
- `GET /accounts/:accountId`
- `GET /accounts/:accountId/reconnect`
- `GET /accounts/:accountId/delete`
- `GET /messages`
- `GET /messages/:messageId`
- `GET /review`
- `GET /finance`
- `GET /runs`
- `GET /profiles/:accountId`
- `GET /events`

### Browser vendor asset routes

- `GET /vendor/echarts/*`
- `GET /vendor/tslib/*`
- `GET /vendor/zrender/*`

These routes serve browser ESM dependencies referenced by the import map. They
are internal browser assets, not application APIs. They must not serve secrets,
org data, runtime DB files, or operator artifacts.

### Browser form and action routes

- `POST /rpc/accounts/connect/google`
- `POST /rpc/accounts/:accountId/reconnect`
- `POST /rpc/accounts/:accountId/pause`
- `POST /rpc/accounts/:accountId/resume`
- `POST /rpc/accounts/:accountId/disconnect`
- `POST /rpc/accounts/:accountId/delete`
- `POST /rpc/accounts/:accountId/sync/full`
- `POST /rpc/accounts/:accountId/sync/delta`
- `POST /rpc/accounts/:accountId/sync/reconcile`
- `POST /rpc/accounts/:accountId/classify/root`
- `POST /rpc/accounts/:accountId/classify/root/messages`
- `POST /rpc/accounts/:accountId/classify/finance`
- `POST /rpc/accounts/:accountId/overseer/rebuild`
- `POST /rpc/messages/:messageId/classify`
- `POST /rpc/reviews/classify`
- `POST /rpc/reviews/:reviewId/resolve`
- `POST /rpc/finance/registry/import`
- `POST /rpc/finance/mappings/upsert`
- `POST /rpc/finance/suggestions/reconcile`
- `POST /rpc/finance/knowledge/rebuild`
- `POST /rpc/finance/rollups/rebuild`
- `POST /rpc/finance/export`
- `POST /rpc/finance/tax/personal`
- `POST /rpc/finance/tax/business/inherent-design`

These mutation routes may be implemented through internal `commands`, but the
external transport contract stays standard Hono HTTP routes.

Classification RPC behavior:

- `POST /rpc/messages/:messageId/classify` queues `classify_root_messages`; it
  must not call the LLM inline
- `POST /rpc/accounts/:accountId/classify/root/messages` queues targeted root
  classification for explicit message ids
- `POST /rpc/reviews/classify` queues `classify_review_backlog`
- review classifier actions may enqueue targeted root or finance jobs through
  worker dispatch only

Finance repair/report RPC behavior:

- `POST /rpc/finance/mappings/upsert` validates one mapping, writes it to
  `operator/registry/finance-account-mappings.yaml`, then queues registry import
  and finance rebuild jobs
- tax/business package RPC routes create `tax_report_runs` rows and queue worker
  jobs; they do not generate packages inline

### Hono RPC routes

Browser mutations are mounted directly under `/rpc/*` in the active contract.
The browser may still use a typed RPC client generated from the Hono app type,
but the canonical browser transport surface is the `/rpc/*` path family above.

Transport handlers may call internal `queries`, `commands`, and domain services,
but those internal boundaries must not change the public route surface unless
the owning spec is updated in the same change.

### External and automation API routes

- `POST /api/finance/imports`

Only `/api/finance/imports` is an active external JSON API in the first vNext
contract. Additional JSON endpoints require their own spec entry before being
added.

## Runtime URL Derivation

Resolved runtime config owns:

- bind host and bind port
- `public_origin`
- `base_path`
- derived WorkOS callback unless `WORKOS_REDIRECT_URI` is explicitly set
- derived Google OAuth callback unless `GOOGLE_OAUTH_REDIRECT_URL` is
  explicitly set

## Middleware Stack

Middleware order is fixed:

1. request id and trace context
2. panic/error boundary
3. secure headers and cookie/session setup
4. WorkOS session decode and principal resolution
5. org selection and `org_id` enforcement
6. org runtime root resolution
7. role/permission guard
8. route handler or stream handler
9. structured response logging and timings

No route handler may touch org-scoped storage before step 6 completes.

Secure headers are applied globally before route handling. The baseline uses
Hono's `secureHeaders` middleware with cross-origin embedder policy disabled
for browser module compatibility and denies unused browser capabilities through
`Permissions-Policy` (`camera`, `geolocation`, `microphone`, `payment`, `usb`).
The app must emit at least:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: no-referrer`
- `Strict-Transport-Security` on all responses
- `Permissions-Policy` denying unused privileged browser APIs

## Request Lifecycle

### Browser GET

1. validate session and organization context
2. resolve org runtime
3. load domain data from org-scoped services
4. render Hono JSX page with serialized props
5. return server-rendered HTML

### Enhanced browser GET

1. validate session and organization context
2. resolve org runtime
3. load domain data from org-scoped services
4. detect `X-Zmail-Partial: main`
5. render only the `#app-main` fragment
6. return:
   - `X-Zmail-Title`
   - `X-Zmail-Url`
   - `X-Zmail-Page`
   - `X-Zmail-Event-Cursor`

### Enhanced island GET

1. validate session and organization context
2. resolve org runtime
3. load domain data from org-scoped services
4. detect `X-Zmail-Partial: islands`
5. parse `X-Zmail-Islands` as a comma-separated list of route-scoped island ids
6. render only requested island fragment templates
7. return:
   - `X-Zmail-Title`
   - `X-Zmail-Url`
   - `X-Zmail-Page`
   - `X-Zmail-Event-Cursor`
   - `X-Zmail-Islands`

The response HTML body contains only an island fragment envelope with the
rendered island roots. It must not include `#app-main`, document chrome, or
unrequested sibling islands. If one or more requested islands are unsupported,
the response may include fallback metadata such as `X-Zmail-Island-Missing`;
SSE-triggered refreshes skip unsupported islands, while explicit user actions
may opt into a same-page `main` fallback.

### Browser POST

1. validate session and organization context
2. parse form payload
3. run command/service mutation
4. on success:
   - redirect to the next page for browser form flows
   - or re-render the page with updated state when inline error/success handling
     is required
5. on validation failure:
   - return `400` or page-local validation errors
6. on permission failure:
   - return `401` or `403`

### JSON API POST

1. validate auth
2. resolve org context
3. parse JSON
4. validate schema
5. run service
6. return structured JSON response

### SSE GET

1. validate session and organization context
2. resolve org runtime
3. parse subscribed topics and replay cursor
4. replay durable runtime events newer than the cursor
5. stream live events plus heartbeats

## JSON API Response Conventions

All JSON APIs must follow this envelope style:

- success:
  - `ok: true`
  - `status: <machine-readable status>`
  - resource-specific fields
- failure:
  - `ok: false`
  - `error: <machine-readable error code>`
  - optional `message`
  - optional `issues`

No route may expose raw stack traces or unstructured exception text to clients.

## Error Handling Contract

Hono owns error mapping:

- malformed JSON: `400`
- schema validation failure: `422`
- unauthenticated: `401`
- authenticated but forbidden: `403`
- missing resource: `404`
- unhandled server failure: `500` with generic machine-safe envelope

Browser pages must render operator-safe error pages. JSON APIs must never return
HTML error bodies.

Current development posture: JSON `500` responses may include `Error.message`
while the product is still in local/in-house operation. Before service release,
replace this with a generic client message plus an operator-visible incident or
trace id so debugability remains without returning raw exception text.

SSE handlers must never emit stack traces or HTML fragments.

## Rendering Responsibility

Hono decides:

- which page component to render
- which org-scoped props are serialized
- which redirects occur after mutations
- which runtime events are replayed or streamed

Hono JSX and `hono/jsx/dom` decide:

- the page/view structure
- interactive island mount points
- client-side enhancement after initial HTML delivery
- partial-fragment rendering for enhanced navigation
- page-owned island fragment rendering for targeted live updates

## SSE Contract

`GET /events` is the canonical browser realtime transport.

Rules:

- auth:
  - WorkOS browser session only
- topic query:
  - `topics=jobs,accounts,account:acct_123,finance,reviews`
- replay cursor:
  - `Last-Event-ID` header or `cursor` query param
- envelope:
  - `id`
  - `event`
  - `data`
- heartbeat:
  - every `15s`

Runtime events must be durable before they are considered streamable.

`GET /events` and `/rpc/**` are browser-session routes only. They do not accept
machine bearer tokens.

## Partial Navigation Contract

The browser shell may request fragment-only responses using:

- `X-Zmail-Partial: main`

Fragment responses must:

- contain only the `#app-main` subtree
- include:
  - `X-Zmail-Title`
  - `X-Zmail-Url`
  - `X-Zmail-Page`

## Out Of Scope

- client-side routing
- framework-generated route trees
- server actions hidden behind component helpers
- cross-org request multiplexing inside one route handler
