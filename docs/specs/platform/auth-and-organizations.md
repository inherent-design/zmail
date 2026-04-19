# Auth and Organizations

## Purpose

This document defines the WorkOS auth and organization model for zmail vNext.

## Scope

Covered here:

- WorkOS AuthKit browser sessions
- organization selection and membership
- role and permission model
- machine token access for automation
- auth failure behavior

This document covers the browser/session auth plane only. Gmail account-linking
OAuth lives under the Gmail domain spec and must not be conflated with WorkOS
session callbacks.

## Auth Provider

WorkOS is the only auth and organization provider in the target contract.

Use:

- WorkOS AuthKit for browser sessions
- WorkOS organizations and memberships for tenancy
- WorkOS machine-to-machine tokens for automation

No Clerk or custom in-house auth layer is part of the active contract.

## Session Principal Shape

Authenticated browser requests must resolve a principal carrying at least:

- `sub`
- `org_id`
- `role`
- `permissions`

Recommended session claims:

- `sub`
- `org_id`
- `role`
- `permissions`
- `organization_membership_id`
- `email`

`org_id` is mandatory before any org-scoped request may proceed.

## Browser Session Lifecycle

1. unauthenticated user requests a protected route
2. Hono redirects to `GET /auth/login`
3. WorkOS completes browser authentication
4. `GET /auth/callback` validates the session
5. if the user has one organization, that organization becomes active
6. if the user has multiple organizations or no active org, redirect to
   `GET /org/select`
7. authenticated requests then proceed with `org_id` attached

Logout:

- `POST /auth/logout`
- clears local session cookies and redirects to a public or login route

Local development follows the same browser-session contract. It does not fall
back to an implicit local admin identity.

Callback derivation:

- if `WORKOS_REDIRECT_URI` is set, use it exactly
- otherwise derive callback from `public_origin + base_path + /auth/callback`

Canonical local callback:

- `http://127.0.0.1:56711/auth/callback`

Canonical hosted callback:

- `https://zmail.inherent.design/auth/callback`

Auth-plane distinction:

- `/auth/*` routes belong to WorkOS browser session authentication
- Gmail account-linking uses separate provider authorization and callback
  handling under the Gmail ingestion contract

## Organization Selection

Every authenticated browser request that touches operator data requires an
active org.

If the WorkOS-authenticated user has:

- exactly one org:
  - use it
- multiple orgs:
  - require explicit selection on `/org/select`
- no orgs:
  - require `/org/create` before any app access

If legacy single-tenant runtime data exists and the selected org has no runtime
root yet, an `org_admin` is redirected to `/org/claim-legacy`.

## Roles

Active org roles:

- `org_admin`
- `org_operator`
- `org_viewer`

These are environment-defined zmail roles in WorkOS, assigned through
organization memberships and embedded in the WorkOS session token.

zmail auto-seeds these environment roles when needed before org creation or
bootstrap-admin promotion. Operators do not need to create per-org custom roles
for the default zmail permission model.

WorkOS now supports multi-role organization memberships through `roles[]`, but
zmail currently collapses WorkOS role data to one effective app role by
precedence: `org_admin` > `org_operator` > `org_viewer`.

For the checked-in local deployment, `auth.workos.bootstrap_admin_emails` in
`zmail.toml` may promote specific browser principals to `org_admin` during
org-bound session bootstrap. This is an idempotent seed path, not a separate
authorization model.

## Permission Matrix

| Capability | org_admin | org_operator | org_viewer |
| --- | --- | --- | --- |
| View pages and detail surfaces | yes | yes | yes |
| Connect new Gmail account | yes | yes | yes |
| Reconnect or disconnect owned Gmail account | yes | yes, if owner | yes, if owner |
| Delete owned local account | yes | yes, if owner | yes, if owner |
| Reconnect, disconnect, or delete any account | yes | no | no |
| Queue sync, classify, overseer, finance rebuild jobs | yes | yes | no |
| Import or reconcile registry/taxonomy | yes | yes | no |
| POST `/api/finance/imports` with browser session | yes | yes | no |
| Claim legacy runtime into org root | yes | no | no |
| Manage org membership and role policy | yes | no | no |

Account ownership is keyed by normalized browser principal email. The creator
of a Gmail account becomes its owner. Owners may reconnect, disconnect, and
delete their own account even when their org role is `org_viewer` or
`org_operator`. `org_admin` remains a universal override.

## Machine Token Model

Automation uses WorkOS M2M tokens.

Required machine-token claims:

- `org_id`
- token subject/client identity
- token expiry

Machine tokens may call only explicitly machine-safe routes. In the first
contract, that means:

- `POST /api/finance/imports`

Machine tokens never imply browser navigation permissions.

## Token and Org Resolution Rules

### Browser requests

- resolve WorkOS session
- require active `org_id`
- require role/permission match
- resolve org runtime root from `org_id`

### Machine requests

- require bearer token
- validate token against WorkOS JWKS for the configured M2M client
- require `org_id`
- map token to org runtime root
- require route-level permission for machine use

## Failure Behavior

- missing session or token: `401`
- valid auth with missing org context: redirect to org selection for browser
  flows, `403` for machine/API flows
- insufficient role/permission: `403`
- invalid token/session: `401`

## Audit and Security Expectations

- every authenticated request includes `org_id` in log context
- destructive actions log actor type:
  - browser user
  - machine token
- no token, secret, or raw provider payload may be logged
- role checks happen before org-scoped storage access

## Future Compatibility

If finer-grained resource authorization is added later, it layers on top of the
org-scoped WorkOS session model. It does not replace `org_id` as the tenancy
boundary.

## Out Of Scope

- custom username/password auth
- unauthenticated local-only operator APIs
- cross-org shared sessions without explicit organization selection
