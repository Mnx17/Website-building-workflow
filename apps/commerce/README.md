# Sweets Commerce

All four phases of the [headless commerce implementation plan](../../docs/headless-commerce-implementation-plan.md):

- **P1** — PostgreSQL schema, inventory RPCs, cart/configuration API.
- **P2** — 3D configurator, bilingual RTL storefront, cart handoff.
- **P3** — checkout, payment webhooks, weight-based shipping, gifting.
- **P4** — staff auth and roles, admin CMS, theme system, rate limiting, audit trail.
- **P4b** — checkout UI, Playwright E2E, WebGL fallback.

## Running it

```bash
npm install
cp .env.example .env          # point DATABASE_URL at a Postgres 15+
npm run db:reset              # migrate + seed
npm run test:unit             # no database required
npm run test:integration      # requires DATABASE_URL
npm run dev
```

`npm run db:reset` drops and recreates the `public` schema — never point it at
anything you care about.

## What is enforced where

Money is **integer baisa** (`bigint`, 1 OMR = 1000 baisa) everywhere. Floats
never touch a price. Rounding to a gateway-acceptable increment happens once,
on the order total, at checkout-session creation (P3) — never per line item.

Business rules that must not be bypassable live in the database, not in
TypeScript, because a second consumer written later would not inherit
application-layer checks:

| Rule | Enforced by |
|---|---|
| A build's price and weight | `price_configuration()` — recomputed from `raw_materials`; the client's estimate is advisory only |
| Slot categories, max qty, required slots, min fill | `price_configuration()` |
| No overselling under concurrency | `reserve_configuration()` with `SELECT … FOR UPDATE`, locking in `raw_material_id` order |
| `reserved_qty <= stock_qty` | check constraint (backstop — if it fires, something bypassed the RPC) |
| Stock committed exactly once per order | `commit_order_stock()`, idempotent on the ledger |
| Legal order transitions | `assert_order_transition()` trigger |
| Non-overlapping shipping weight bands | GIST `EXCLUDE` constraint |
| A line item is a product XOR a configuration | `num_nonnulls(...) = 1` check constraint |
| Audit trail is append-only | `DO INSTEAD NOTHING` rules on `inventory_ledger` |

## Inventory model

Two-phase: **reserve on add-to-cart, commit on payment**. Available stock is
always `stock_qty - reserved_qty`; never read `stock_qty` alone.

| Phase | Trigger | Effect |
|---|---|---|
| Reserve | add to cart | `reserved_qty += n`, cart held 30 min |
| Release | cart expiry sweep, or line removal | `reserved_qty -= n` |
| Commit | payment confirmed | `stock_qty -= n` and `reserved_qty -= n` |
| Restock | refund | `stock_qty += n` |

`inventory_ledger` carries **two** delta columns (`delta_stock_qty`,
`delta_reserved_qty`) rather than one signed quantity. A single column cannot
reconcile: a reservation moves `reserved_qty` without moving `stock_qty`, while
a commit moves both. With two axes the invariant is exact and is asserted after
every mutating integration test:

```
raw_materials.stock_qty    = sum(delta_stock_qty)
raw_materials.reserved_qty = sum(delta_reserved_qty)
```

`commit_order_stock()` returns `committed | already_committed |
reservation_lost` rather than raising, because a webhook handler that throws is
retried forever. `reservation_lost` means the hold lapsed before payment
landed — the webhook flags that order for manual review instead of shipping
stock that is not there (see "Review queue" below).

## API

| Route | Purpose |
|---|---|
| `POST /api/configurations/price` | Authoritative price for an in-progress build. Read-only; safe to call debounced on every change. |
| `POST /api/cart` | Create a cart. |
| `GET /api/cart/:cartId/items` | Cart summary with subtotal and total weight. |
| `POST /api/cart/:cartId/items` | Add a product or a composite build. Composite adds also take the stock reservation, in one transaction. |
| `DELETE /api/cart/:cartId/items/:itemId` | Remove a line and release its hold. |

## Migrations

Applied in filename order by `scripts/db.mjs`, which records what ran in
`schema_migrations`. On Supabase, use `supabase db push` instead; the runner
exists so CI can use a plain Postgres container.

`0000_compat.sql` shims `auth.users` / `auth.uid()` for non-Supabase Postgres.
Every statement is guarded, so it is a no-op on a real Supabase project — it
must never replace Supabase's own `auth.uid()`.

## The configurator (P2)

Routes are `/[locale]/configure/[slug]`, locale being `en` or `ar`. `/`
redirects to a locale based on `Accept-Language`.

```
ConfiguratorClient          hydrates bigint money from wire strings
 └─ ConfiguratorProvider    per-mount zustand store (never module-level)
     ├─ ConfiguratorCanvas  frameloop="demand", dpr/shadow downgrade
     │   └─ ProductModel
     │       ├─ BoxShell | BouquetRing   procedural placeholder geometry
     │       ├─ SlotDropZone × n         colliders, highlight, shake-on-reject
     │       └─ SlotContents             what is placed, by slot position
     ├─ MaterialTray        drag source AND tap-to-select
     ├─ PriceTicker         optimistic estimate, server-confirmed badge
     └─ AddToCartBar        gated on the same rules the database enforces
```

**State.** The store is zustand *vanilla* (`createStore`), not the React hook,
for two reasons: the interaction rules are unit-testable in Node with no
renderer, and a module-level store would be shared across SSR requests,
leaking one visitor's build into another's.

**Pricing.** `estimate()` mirrors `price_configuration()` so the ticker updates
on the same frame as the drop. It is not an authority: `usePriceSync` confirms
against the server 400ms after the last change, discards responses for
superseded revisions, and any edit clears the stored server price so a stale
`config_hash` can never reach the cart.

**Input.** Drag and tap are both first-class — dragging from DOM onto a WebGL
canvas is unreliable on mobile browsers, so touch users get tap-a-material then
tap-a-slot. Tapping a filled slot with nothing in hand empties it.

**Performance.** `frameloop="demand"` is the important one: the scene is static
between interactions, and rendering it continuously is what drains a phone
battery. `dpr` and shadows start conservative on devices reporting ≤4 cores, and degrade
further via drei's `PerformanceMonitor`.

**RTL.** `dir` is set on `<html>` from the route segment, never toggled by
client script. The stylesheet uses logical properties only, and
`tests/unit/rtl-guard.test.ts` fails the build if a physical one appears. The
3D scene is deliberately **not** mirrored — world coordinates are identical in
both locales, and slot order comes from `composite_slots.position`, never from
DOM order.

### Placeholder geometry

There are no GLB assets yet, so the box and bouquet are procedural meshes and
placed items are colour-coded spheres. `model_url` is already carried from the
database through to the components, so the swap to Draco+Meshopt GLBs via
`useGLTF` is confined to `ProductModel` and `SlotContents`. **Until real models
land, P2 is not visually complete** — the interaction, pricing and cart paths
are.

## Checkout, payments and gifting (P3)

| Route | Purpose |
|---|---|
| `POST /api/checkout/session` | Recomputes totals from the cart, creates the order, returns a gateway URL (or nothing extra for COD). |
| `POST /api/webhooks/:provider` | Verifies the signature, dedupes the event, commits stock. |
| `GET /api/orders/:id/documents?type=` | `invoice` (priced) or `packing_slip` (price-free). Staff, or the buyer for their own invoice. |

**Payment is behind an interface, not a Thawani import.** The merchant's
acquiring options are not confirmed — Stripe cannot onboard an Omani entity —
so `PaymentProvider` (`createSession`, `verifyWebhook`, `refund`) is what
checkout depends on. MyFatoorah slots in as a second adapter without touching
anything above it.

**`PAYMENT_PROVIDER=mock`** signs and verifies through the same code path as
Thawani, so the webhook route is fully exercised in CI. It is refused when
`NODE_ENV=production` unless explicitly allowed, so a misconfigured deploy
cannot accept unsigned "payments".

### Webhook ordering

The order of operations is the design:

1. Read the **raw** body. `request.json()` first would change the bytes the
   signature covers.
2. Verify: timing-safe compare, timestamp window, hex or base64.
3. Insert into `webhook_events (provider, event_id)`. A unique violation means
   it is already handled → return 200. That is the replay guard.
4. Only then mutate, with the status change and the stock commit in **one**
   transaction.

Anything already handled returns 200. A gateway that receives a 500 retries, so
throwing on a duplicate retries forever.

### Where rounding happens

Once, on the order grand total, at checkout-session creation — never per line
item. The delta is persisted in `orders.rounding_adjustment_baisa` and the
`totals_reconcile` check constraint enforces
`subtotal + shipping + vat + adjustment = total`. Cash on delivery skips
rounding entirely: snapping to 10 baisa would make the driver's change wrong.

### Gifting

`hide_prices` governs **recipient-facing documents only**; the buyer always
sees full prices.

The guarantee is enforced by the **type**, not by a template remembering to
omit a field. `PackingSlipDocument` has no price-shaped property anywhere in
its shape, so a renderer cannot print one and a future edit cannot reintroduce
one without a compile error. Tests assert the rendered output against a broad
price-shaped pattern set in both locales — and assert that the same patterns
*do* match the invoice, so the detector cannot silently rot.

Blocked combinations: **gift + COD** (asking a recipient to pay for their own
present is a support incident) and **gift + international** (customs legally
requires a declared value, so the price-free slip cannot be the customs form).

Gift messages are counted in **grapheme clusters** via `Intl.Segmenter` —
`String.length` overcounts Arabic diacritics badly and would tell a customer
their message is too long when it visibly is not. A flagged message is held for
review, never silently edited.

### Documents are HTML, not PDF — deliberately

A PDF with Arabic needs an embedded font with real Arabic coverage. Rendering
Arabic without one produces disconnected, reversed glyphs that look fine to a
non-reader and are unusable to the recipient. Shipping that would be worse than
shipping nothing. The document *model* is renderer-independent, so React-PDF
slots in behind the same functions once a licensed Arabic face is vendored.
Browser print-to-PDF handles Arabic correctly today, which covers fulfilment.

## Admin, auth and hardening (P4)

### Two access paths, two mechanisms

This is the thing most likely to trip up the next person, so it is worth being
explicit:

| Path | Identity | Enforced by |
|---|---|---|
| Browser to PostgREST with the anon key | Supabase JWT, `auth.uid()` | **RLS policies** (`0003_rls.sql`) |
| Route Handler to `postgres.js` with the service role | JWT verified in `lib/auth.ts` | **`requireRole()` in the handler** |

On the second path `auth.uid()` is **always null** — there is no JWT on that
connection. A `has_role()` check inside a function called from a Route Handler
therefore rejects every legitimate call while looking like protection. That is
why `activate_theme` takes an explicit actor argument, and why authorisation
for the admin API lives in `requireRole`, not in RLS.

RLS is not decorative: it protects the anon-key path and is the backstop if
anything is ever exposed through PostgREST. But it is not what guards
`/api/admin/*`.

### Auth

Supabase issues HS256 JWTs signed with the project secret, so verification is a
local HMAC check — no network call per admin request. The token establishes
*who*; it never establishes *what they may do*. The role is read from
`staff_users` server-side, so a token claiming `role: admin` is ignored.

The verifier pins the algorithm rather than trusting the token's own `alg`
header — accepting that header is the classic JWT bypass (`alg: none`, or
HS256-signed-with-the-public-key). Tests cover both.

Everything fails closed: no secret configured returns 503, not "allow
everything in development".

### Admin API

| Route | Read | Write |
|---|---|---|
| `/api/admin/products`, `/materials` | any staff | admin, editor |
| `/api/admin/composites` | any staff | admin |
| `/api/admin/inventory` | any staff | admin, editor |
| `/api/admin/orders` | any staff | admin, fulfillment |
| `/api/admin/theme` | any staff | admin |
| `/api/admin/audit` | admin | — |

Writes go through one factory (`lib/admin/route-factory.ts`) so the role check,
the audit trail and the error mapping cannot drift apart between routes — the
usual way an admin panel ends up with one endpoint that forgot a check.

Two things are deliberately not writable through it:

- **`stock_qty`** — stock moves only through `adjust_stock()`, which writes the
  ledger in the same transaction. A direct UPDATE would break
  `stock_qty = sum(delta_stock_qty)` silently. The API returns 422 saying where
  to go instead.
- **Any column not on the allowlist** — unknown fields are dropped, not
  trusted, so a client cannot set `id` or `created_at`.

### Audit trail

Every catalogue mutation writes before/after into `admin_audit_log` in the same
transaction as the change. If the audit insert fails, the change fails: an
unaudited edit is not an acceptable fallback when the point is answering "who
dropped this price to 1 baisa". Append-only, enforced by rules.

Note that row snapshots contain `bigint` money columns, which `JSON.stringify`
refuses to serialise — they are converted to decimal strings, matching how
money crosses every other boundary here.

### Rate limiting

Fixed-window counters in Postgres, not in memory: Route Handlers run on
instances that share no process state, so an in-memory limiter multiplies the
real limit by the instance count and resets on every cold start.

Cart-scoped endpoints key on the **cart id**, not the IP. That is both more
accurate (one shopper behind CGNAT is not a hundred) and avoids a trap: with no
proxy header every caller would otherwise share one bucket, so the first N
customers per minute would check out and everyone else would get 429. Where no
identifier can be determined at all the limiter **does not limit** and warns —
a throttle that takes the site down is worse than no throttle.

It also fails open on a database error. Losing throttling for a few minutes is
cheaper than losing sales.

### Theme system

The active theme is read per request in the root layout and emitted as CSS
custom properties — no client JS, no flash of unthemed content. Colours are
re-validated before going into the `<style>` tag even though the column has a
CHECK constraint, and the font name is stripped: that string is interpolated
into CSS, and a value that arrived by another route must not become injection.

Fonts are restricted to an Arabic-capable whitelist. Most Latin display faces
silently fall back for Arabic glyphs, which wrecks half the storefront while
looking fine to whoever picked the font.

### Review queue

`commit_order_stock` returning `reservation_lost` now sets `needs_review` with
a reason and surfaces it at the top of the admin dashboard. The customer has
been charged for stock that may not exist — logging that was not enough.

## End-to-end tests

```bash
npm run build          # E2E runs against a production build, not next dev
npm run test:e2e
```

The suite drives a real browser through the gift checkout flow in **both
locales and both viewports**: cart summary, governorate, gift toggle, recipient
fields, Arabic message, payment round trip, and the price-free packing slip as
a browser actually receives it. It also asserts the invoice *does* show prices,
so the check cannot rot into vacuous truth.

It runs against `next start` deliberately. The dev server differs enough around
RSC, caching and dynamic rendering that a suite green there can still fail in
production — which is the failure this layer exists to catch. It earned that
immediately: it found an infinite render loop (React #185) in `MaterialTray`
that typecheck, 113 unit tests and 71 integration tests all missed, because it
only manifests during hydration in a real browser. The configurator route was
crashing for every user in a production build.

**What it does not cover:** the cart is seeded through the API rather than by
dragging across the WebGL canvas. Driving three.js raycasting with a synthetic
pointer produces flaky tests rather than real coverage, and the interaction
rules already have 21 dedicated store unit tests. The gap is honest: nothing
verifies that a human can physically drag a sweet into a slot.

Each test presents a distinct `x-forwarded-for`, because each test *is* a
different shopper. This does not disable rate limiting — it stays enforced per
simulated client, exactly as production sees it.

## WebGL fallback

If WebGL is unavailable — headless Chrome, a locked-down corporate build, an
old Android, a GPU blocklist — the configurator renders its slots as a list
instead. Every interaction rule lives in the store, so tapping a slot in the
fallback behaves exactly as tapping it in 3D, and pricing, validation and
add-to-cart are untouched.

This is the non-3D fallback the plan's risk register asked for. Without it a
missing WebGL context throws during hydration and Next replaces the whole
document with "Application error" — the shopper cannot even see the products.

## Known gaps

- **No GLB models.** The configurator runs on placeholder geometry (see above).
  This is the critical-path dependency for P2 being visually done.
- **No live payment has ever been made.** The Thawani adapter's session shape
  follows the published API, but the webhook signature header names and payload
  envelope are **unverified against a real sandbox** — no merchant credentials
  exist yet. Both are isolated in `parseWebhookBody` and the header constants;
  confirm them during onboarding. The signature verification itself (raw body,
  timing-safe, timestamp window) is provider-independent and correct.
- **Nothing drives the 3D canvas.** Playwright covers checkout end to end, but
  no test verifies that a human can drag a sweet into a slot; that path rests
  on the store unit tests and the WebGL fallback.
- **No sign-in UI.** The admin API and shell verify Supabase JWTs, but nothing
  here renders a login form or refreshes a session — that needs the Supabase
  client wired to a real project. The shell shows its locked state until then.
- **No composite template builder UI.** The API accepts slot definitions, but
  the 3D slot picker from the plan is not built; slot positions are edited as
  JSON. Lower value until real models exist.
- **No product/material admin screens.** Full CRUD exists over the API and is
  tested; only the dashboard, inventory and audit views are rendered.
- **No load test.** Named in the plan's P4 and still outstanding.
- Buyer accounts are not wired: carts stay anonymous, so `orders.user_id` is
  only ever set by an admin. The buyer-reads-own-invoice path exists and is
  tested, but nothing populates it yet in normal use.
- Cart line quantities can be added but not edited; only whole-line removal is
  wired.
- No confirmation emails. The gifting rules define which template each
  recipient gets, but no mail transport is wired.
- No checkout UI. P3 ships the API and the rules; the storefront still needs
  the address/gift form that calls `POST /api/checkout/session`.
