# ADR 001: Hono JSX Over Ripple

## Status

Superseded by
[ADR 002: SvelteKit UI and Hono WebSocket](./adr-002-sveltekit-ui-and-hono-websocket.md).

## Historical Decision

This ADR previously selected Hono JSX, `hono/jsx/dom` islands, enhanced MPA
navigation, and SSE over Ripple during the transition away from TanStack.

## Current State

The active target no longer uses Hono JSX for browser page rendering. SvelteKit
owns browser pages and Hono owns API/auth/WebSocket routes.
