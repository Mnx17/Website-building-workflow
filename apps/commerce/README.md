# Sweets Commerce — P1 + P2

Phases 1 and 2 of the [headless commerce implementation plan](../../docs/headless-commerce-implementation-plan.md):

- **P1** — PostgreSQL schema, inventory RPCs, cart/configuration API.
- **P2** — 3D configurator, bilingual RTL storefront, cart handoff.

Checkout, payments, shipping and gifting are P3; the admin CMS is P4.

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
landed — P3 must flag that order for manual review instead of shipping stock
that is not there.

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

## Known gaps

- **No GLB models.** The configurator runs on placeholder geometry (see above).
  This is the critical-path dependency for P2 being visually done.
- **No browser-level tests.** The interaction rules are covered by 21 store
  unit tests, but nothing drives a real pointer over a real canvas; Playwright
  arrives with the P3 gift-checkout suite.
- No authentication yet. Carts are anonymous; `staff_users` and the RLS
  policies are in place but nothing populates `auth.uid()` (P4).
- Route Handlers have no rate limiting. `POST /api/cart` is an unauthenticated
  insert, and `POST /api/configurations/price` is callable at will.
- Cart line quantities can be added but not edited; only whole-line removal is
  wired.
- Shipping rates are seeded and constrained but the calculator itself is P3.
