# Renewals Flow and Settings Page Commit Summary

Generated from local git history across:

- `gx-client-next`
- `gx-backend`
- `gx-admin-client`

Scope note: I searched all refs for commits authored by Pranav and grouped the renewal-flow and settings-page related work into product-task blurbs. Older or unrelated matches from generic terms like `membership`, `account`, `payment`, and `address review` were excluded unless they directly supported the renewal/settings work described below.

## Executive blurb

The recent work turned renewals from a loosely inferred membership/payment path into an explicit, observable renewal flow: backend membership state now exposes plan-level expiry and subscription state, payment dispatch distinguishes renewal lifecycle context, expiry reminders are tracked through Clevertap, and the client consumes that read model to show accurate active/past subscription information. In parallel, the settings page was expanded into a member self-serve surface for subscription details and account address management, backed by safer backend CRUD and admin/client null-safety fixes.

## Renewal flow

- Built the backend membership renewal foundation: added membership subscription/state-machine groundwork, backfills from legacy payments, projected access rebuilds, shadow comparisons, flagged dual writes, idempotency coverage, outbox/scheduled transitions, and entitlement-read rollout support.
- Added explicit expiry/subscription read-model support: plan-level `expires_at`, `subscription_state`, expiry task metadata cleanup, undefined-state guards, legacy fallback handling, and client consumption of the `/v2/me` subscription fields.
- Renamed and propagated the renewal payment flag across backend and client so renewal purchases are intentionally marked instead of inferred from generic membership payments.
- Split backend membership payment dispatch so renewal flows can carry distinct lifecycle context, while the client passes renewal guard lifecycle context explicitly.
- Added renewal-flow analytics and legacy tracking compatibility across backend Clevertap events and frontend instrumentation, including the documented legacy renewal guard alias.
- Added expiry countdown/milestone reliability work: pre-expiry Clevertap countdown events, renamed expiry events, guarded/atomic milestone writes, CRUD-routed expiry countdown persistence, and aligned claim-flow docs.
- Exposed subscription plan products with usage from the backend, then routed/mapped those products in the client so active subscription products resolve to learning products instead of relying on mock or incomplete local data.
- Hardened edge cases around subscription state by guarding missing membership status and including blacklisted subscription state handling.

Representative commits:

- `gx-backend`: `977a707b2`, `1f65636bb`, `32e148644`, `c3d6e911c`, `904880119`, `813b04cb1`, `249b6e7ca`, `7703d856a`, `ecafd25c1`, `4807c1b64`
- `gx-backend`: `2508c33f4`, `80cbf3af7`, `66f79744c`, `81e9fa78d`, `10c849cda`, `0c9e2e59c`, `1fd12976d`, `367543789`, `cbf42b9cd`
- `gx-client-next`: `a0b377c41`, `ea24b8f01`, `0d66a167e`, `c9072e8ec`, `e03ce6344`, `8f74281ef`, `5cfc93e81`, `cf0aa2a0e`, `866a87219`

## Settings page

- Added a settings subscription details tab and gated its visibility so the subscription surface is shown only when supported.
- Added active and past subscription presentation: active products are mapped to learning products, past subscriptions are shown separately, community subscription noise is hidden, and mock subscription artifacts were removed.
- Switched settings subscription details to backend-provided plan products with usage, reducing client-side inference and keeping the UI aligned with the backend subscription read model.
- Added member account address management on the client and moved user address updates to database CRUD on the backend, so settings address changes are persisted through the correct data path.
- Hardened settings/account edge cases: missing/empty address objects, optional address fields, city-level billing-address validation, missing addresses arrays, profile-picture fallback, settings preview company derivation from live experience, and missing subscription plan data in admin.

Representative commits:

- `gx-client-next`: `19ca340b3`, `8ced0953d`, `d6a56b282`, `9742d20bc`, `a5540f164`, `c123a9cd9`, `866a87219`
- `gx-client-next`: `bd966bf19`, `1e7ac01f6`, `921fa7b39`, `92beb5752`, `69d709002`, `f9071dc97`, `01e080b5b`, `6742a4d11`
- `gx-backend`: `292ff5edd`, `1fd12976d`
- `gx-admin-client`: `399efda`, `756d5ab`, `62d8c8d`

## Repo-by-repo summary

### `gx-backend`

- Renewal core: membership FSM/backfill/projection work, renewal flag rename, split membership payment dispatch, expiry/read-model fields, Clevertap countdown/analytics, plan-products-with-usage endpoint, and subscription state guards.
- Settings support: user address updates moved to database CRUD and subscription plan product data exposed for the client settings subscription tab.

### `gx-client-next`

- Renewal client: renewal flag propagation, `/v2/me` subscription-state consumption, renewal analytics, explicit guard lifecycle context, and active subscription product routing/mapping.
- Settings UI: subscription details tab, active/past subscription tables, gated tab visibility, community subscription hiding, subscription mock cleanup, account address management, and settings null/fallback fixes.

### `gx-admin-client`

- Admin hardening: handled missing subscription plan data and null/undefined address data, with historical member subscription view work as background context.

## Collection details

Commands used:

- `git fetch --all --prune` in each repo before reading history.
- `git log --all --regexp-ignore-case --author='Pranav\\|pranav\\|psbakre' --grep='renew\\|subscription\\|membership\\|expiry' ...`
- `git log --all --regexp-ignore-case --author='Pranav\\|pranav\\|psbakre' --grep='settings\\|setting\\|address\\|account' ...`

Collection notes:

- `gx-backend` was on `fix/admin-user-membership-status-guard` with no upstream configured, so `git log @{u}` could not be used there. Fetch still succeeded and history was read from all local/remote refs.
- The matching history includes duplicate commits across local and remote feature branches in a few places; the summary de-duplicates by task rather than listing every duplicate ref.
