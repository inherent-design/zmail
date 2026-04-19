# ADR 001: Hono JSX Over Ripple

## Status

Accepted.

## Decision

zmail vNext uses:

- `Hono` as the only HTTP server and route owner
- `Hono JSX` as the only HTML rendering layer
- `hono/jsx/dom` for client islands
- enhanced MPA navigation plus authenticated SSE for live updates

`Ripple` is removed from the critical path.

## Rationale

- Hono JSX has tighter integration with the chosen server runtime
- the browser model is server-first and does not require a separate SPA
  framework
- the rewrite needs a small, predictable hydration surface rather than another
  framework decision still under evaluation
- typed imperative calls are already well served by Hono RPC and `hc`

## Consequences

- active specs and implementation target Hono JSX, not Ripple
- any Ripple investigation is optional research only
- the browser runtime is intentionally small:
  - partial navigation
  - page module mounting
  - SSE subscriptions
  - JSON mutation helpers

## Out Of Scope

- defending Ripple as a parallel production path
- introducing a second UI framework for the same routes
