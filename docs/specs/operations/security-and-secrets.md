# Security and Secrets

## Purpose

This document defines the security boundary and secret-handling model for
zmail vNext.

## Security Boundary

zmail is no longer modeled as a purely local open operator tool.

The active security boundary is:

- WorkOS-authenticated browser sessions
- WorkOS-authenticated org-scoped machine tokens
- org runtime isolation on disk and in SQLite

No operator API is implicitly trusted because it is “running on localhost”.

## Auth Boundary

### Browser

- WorkOS AuthKit owns browser identity
- every protected page requires a valid session
- every org-scoped request requires `org_id`
- permission checks happen before storage access

### Automation

- machine clients authenticate with WorkOS M2M bearer tokens
- tokens must carry `org_id`
- only explicitly machine-safe endpoints are callable

## Finance Import Security

`POST /api/finance/imports` must enforce:

- `401` for missing or invalid auth
- `403` for wrong role or wrong org
- `400` for invalid JSON
- `422` for invalid artifact schema

It must never:

- accept open unauthenticated POSTs
- expose raw exception payloads
- leak internal stack traces

## Secret Classes

### Repo-managed bootstrap secrets

Allowed in encrypted repo-managed secret storage:

- Google OAuth bootstrap credentials
- WorkOS browser/session bootstrap credentials needed for shared local
  development
- WorkOS M2M client bootstrap credentials when finance import automation is
  enabled

Canonical encrypted bootstrap source:

- `secrets.enc.yaml` at repo root

Canonical local loading path:

- native `mise` task-level `env._.file` loading from `secrets.enc.yaml`

Rules:

- only server-side `mise` tasks may load repo-managed bootstrap secrets during
  local development
- secret loading must happen through `sops + age`
- deployments must receive the same values through orchestration or runtime env
  injection
- `zmail.toml` and `.env.example` are non-secret config surfaces only
- if a manual decrypt/export helper is used for debugging, its output must
  never live in a repo-tracked path and must never be committed, copied into
  `public/`, or copied into `data/`

Canonical shared local WorkOS bootstrap keys are:

- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- optional `WORKOS_M2M_CLIENT_ID`
- optional `WORKOS_M2M_CLIENT_SECRET`

Not part of the current shared local runtime contract:

- `WORKOS_CLIENT_SECRET`
- the default local `WORKOS_REDIRECT_URI`

Hosted deployment requires this bootstrap set:

- `ZMAIL_PUBLIC_ORIGIN`
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_COOKIE_PASSWORD`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

Optional hosted overrides:

- `ZMAIL_BASE_PATH`
- `WORKOS_REDIRECT_URI`
- `GOOGLE_OAUTH_REDIRECT_URL`
- `WORKOS_M2M_CLIENT_ID`
- `WORKOS_M2M_CLIENT_SECRET`

`WORKOS_REDIRECT_URI` and `GOOGLE_OAUTH_REDIRECT_URL` are explicit override
escapes. The default contract derives them from `ZMAIL_PUBLIC_ORIGIN` and
`ZMAIL_BASE_PATH`.

For shared local bootstrap, rely on the derived callback contract instead of
storing the default local `WORKOS_REDIRECT_URI` in `secrets.enc.yaml`.

Deployment/runtime env ownership for hosted environments lives under:

- `~/production/inherent.design/platform/services`

### Machine-global local secrets

Remain outside repo-managed secret storage:

- `OPENAI_API_KEY`
- `data/openai-subscription.json`

### Org-local secrets

Never commit:

- `data/orgs/<orgId>/accounts/<accountId>/google-oauth.json`
- org-local raw RFC822 files
- org-local exported machine-token credentials if stored locally

### Machine-token client secrets

WorkOS M2M bootstrap credentials may live in `secrets.enc.yaml` for shared
local development and CI bootstrap.

Rules:

- never store decrypted values in org-authored registry/taxonomy YAML
- never write decrypted values into org runtime roots
- prefer environment injection or dedicated secret stores on long-lived
  automation hosts beyond the local bootstrap path

## Cookie and Token Handling

- session cookies are HTTP-only and secure in non-local environments
- access tokens are never logged
- WorkOS token claims are reduced to safe metadata in logs

## Logging Redaction

Never log:

- access tokens
- refresh tokens
- auth headers
- session cookies
- Gmail OAuth codes
- WorkOS callback payloads
- raw finance artifact payloads
- email bodies, snippets, or addresses

Allowed log metadata:

- ids
- org/account/message/review/job ids
- counts
- status codes
- durations
- model names

## Metrics and Local Observability

`/metrics` is disabled by default. When enabled, bind zmail to a local or
private interface unless an external auth or network policy protects the port.

Never use these values as metric labels:

- email addresses
- sender addresses
- subjects
- snippets
- message bodies
- raw HTTP paths
- OAuth or provider tokens
- raw exception messages

Allowed metrics metadata matches the log metadata boundary: org and account IDs,
job IDs where needed, counts, status values, durations, model names, normalized
routes, and low-cardinality operation names.

Local Loki labels must stay low cardinality. Use service, environment, level,
kind, operation, and event. Do not promote account IDs, message IDs, subjects,
or errors into Loki labels.

## Local Development Assumptions

Local development is still local-first, but not auth-free.

Rules:

- local runs must still use WorkOS auth for protected pages and browser-facing
  APIs
- local non-secret config defaults come from `zmail.toml`
- canonical local origin is `http://127.0.0.1:56711`
- canonical local WorkOS callback is `http://127.0.0.1:56711/auth/callback`
- Gmail OAuth bootstrap secrets remain required for Gmail flows
- local M2M testing must use real or test WorkOS machine credentials
- local development does not have a silent local-admin auth fallback

## `.gitignore` and Repo Hygiene

The repo must ignore:

- org-local DB files
- org-local OAuth files
- org-local raw RFC822 files
- machine-local inference credentials
- generated machine-token credentials or caches

## Out Of Scope

- custom auth beyond WorkOS
- storing secrets in operator YAML
- open local-only import APIs
