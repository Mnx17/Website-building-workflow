-- 0006_lock_down_rpc.sql
--
-- CRITICAL. Supabase publishes every function in the `public` schema as a
-- PostgREST RPC endpoint reachable with the ANON key — the key that ships
-- inside the browser bundle. Our privileged helpers are SECURITY DEFINER,
-- which means they deliberately bypass RLS. Without this migration, anyone
-- with that public key could call:
--
--   POST /rest/v1/rpc/adjust_stock              -> set any stock level
--   POST /rest/v1/rpc/commit_order_stock        -> commit stock for any order
--   POST /rest/v1/rpc/release_cart_reservations -> drop anyone's holds
--   POST /rest/v1/rpc/restock_order             -> inflate stock
--   POST /rest/v1/rpc/reserve_configuration     -> hold the whole catalogue
--   POST /rest/v1/rpc/purge_rate_limits         -> wipe the throttle
--
-- None of this is reachable on a plain PostgreSQL instance, because there is
-- no PostgREST in front of it. That is exactly why the local integration
-- suite could not catch it and the first real deploy did; Supabase's own
-- security advisor flagged it (lints 0028 / 0029).
--
-- The functions are called only by Route Handlers holding the SERVICE ROLE
-- key, so revoking the public roles closes the hole without changing the app.

do $$
declare
  fn text;
  privileged text[] := array[
    'price_configuration(uuid, jsonb)',
    'upsert_configuration(uuid, jsonb, text, uuid)',
    'reserve_configuration(uuid, uuid, integer)',
    'release_cart_reservations(uuid)',
    'release_expired_reservations()',
    'commit_order_stock(uuid)',
    'restock_order(uuid)',
    'adjust_stock(uuid, integer, ledger_reason, text, uuid)',
    'activate_theme(uuid, uuid)',
    'bump_rate_limit(text, integer)',
    'purge_rate_limits()'
  ];
  has_supabase_roles boolean;
begin
  -- The anon / authenticated / service_role roles exist only on Supabase.
  -- Guarded so this migration still applies to the plain PostgreSQL used by
  -- local development and CI, where PostgREST is absent and the exposure this
  -- fixes does not exist.
  select exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'service_role')
    into has_supabase_roles;

  foreach fn in array privileged loop
    if has_supabase_roles then
      -- Revoking from `anon, authenticated` ALONE is not enough and fails
      -- silently: Postgres grants EXECUTE to PUBLIC by default on every new
      -- function and both roles inherit it, so the statement succeeds while
      -- has_function_privilege('anon', ...) still returns true. The grant has
      -- to come off PUBLIC, and service_role then needs it back explicitly.
      execute format('revoke all on function %s from public, anon, authenticated', fn);
      execute format('grant execute on function %s to service_role', fn);
    else
      execute format('revoke all on function %s from public', fn);
    end if;
  end loop;
end
$$;

-- `has_role` and `my_staff_role` KEEP their grants, deliberately.
--
-- RLS policies on public tables reference has_role(), and Postgres evaluates
-- every permissive policy for the calling role — including the staff-write
-- policies — when anon merely SELECTs the catalogue. Revoking EXECUTE here
-- would make public catalogue reads fail with a permission error. Both are
-- safe to expose: they report only the caller's own role, and for anon
-- `auth.uid()` is null, so they return false/null.

-- Pin the trigger function's search_path (advisor lint 0011). A mutable
-- search_path lets a caller's setting change which objects a function resolves.
create or replace function assert_order_transition()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if old.status = new.status then return new; end if;

  if not (
    (old.status = 'pending'    and new.status in ('paid', 'cancelled')) or
    (old.status = 'paid'       and new.status in ('processing', 'refunded', 'cancelled')) or
    (old.status = 'processing' and new.status in ('shipped', 'refunded')) or
    (old.status = 'shipped'    and new.status = 'delivered')
  ) then
    raise exception 'ILLEGAL_TRANSITION:%->%', old.status, new.status using errcode = 'P0001';
  end if;

  if new.status = 'paid' and new.paid_at is null then
    new.paid_at := now();
  end if;

  return new;
end
$$;

-- Advisor lint 0014 (btree_gist installed in `public`) is left as is: moving
-- the extension risks invalidating the shipping_rates exclusion constraint
-- that depends on its operator class, and the finding is namespace hygiene
-- rather than a privilege issue. Revisit deliberately, not in passing.
