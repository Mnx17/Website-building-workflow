# Sweets Commerce — P1 (data model + headless backend)

Phase 1 of the [headless commerce implementation plan](../../docs/headless-commerce-implementation-plan.md):
the PostgreSQL schema, the inventory RPCs, and the cart/configuration API. The
storefront and 3D configurator arrive in P2.

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

## Known gaps at the end of P1

- No authentication yet. Carts are anonymous; `staff_users` and the RLS
  policies are in place but nothing populates `auth.uid()` (P4).
- Route Handlers have no rate limiting. `POST /api/cart` is currently an
  unauthenticated insert.
- `price_configuration` is called once per add-to-cart and once per debounced
  keystroke; no caching yet.
- Shipping rates are seeded and constrained but the calculator itself is P3.
