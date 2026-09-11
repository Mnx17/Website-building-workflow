-- 0005_admin.sql
-- Admin hardening: an audit trail for catalogue edits, a rate-limit counter,
-- and an explicit review queue for orders whose stock could not be committed.

-- ---------------------------------------------------------------- audit log --
-- inventory_ledger already covers stock movement. This covers everything else
-- staff can change: prices, availability, slot rules, theme. Without it, "who
-- dropped the price of the halwa tin to 1 baisa and when" is unanswerable.
create table admin_audit_log (
  id          bigserial primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  entity      text not null,                -- 'products' | 'raw_materials' | ...
  entity_id   text not null,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index admin_audit_entity_idx on admin_audit_log (entity, entity_id, created_at desc);
create index admin_audit_actor_idx  on admin_audit_log (actor_user_id, created_at desc);

create rule admin_audit_no_update as on update to admin_audit_log do instead nothing;
create rule admin_audit_no_delete as on delete to admin_audit_log do instead nothing;

alter table admin_audit_log enable row level security;
create policy admin_audit_read on admin_audit_log
  for select using (has_role('{admin}'));

-- -------------------------------------------------------------- rate limits --
-- Fixed-window counter in Postgres rather than in memory: Route Handlers run
-- on serverless instances that do not share process state, so an in-memory
-- limiter silently multiplies the real limit by the instance count.
create table rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);
create index rate_limits_window_idx on rate_limits (window_start);

alter table rate_limits enable row level security; -- service role only

/**
 * Increments and reports whether the caller is over the limit.
 * Returns the hit count within the current window.
 */
create or replace function bump_rate_limit(
  p_bucket        text,
  p_window_seconds integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  -- Floor the clock to the window, so every caller in the same window shares a row.
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into rate_limits (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
  do update set hits = rate_limits.hits + 1
  returning hits into v_hits;

  return v_hits;
end
$$;

/** Housekeeping; scheduled alongside the reservation sweep. */
create or replace function purge_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted integer;
begin
  delete from rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- ------------------------------------------------------------ review queue --
-- commit_order_stock can return 'reservation_lost': the customer paid, but the
-- hold lapsed first, so the stock may not exist. Logging that was not enough —
-- it needs to reach a human.
alter table orders
  add column needs_review boolean not null default false,
  add column review_reason text;

create index orders_needs_review_idx on orders (placed_at desc) where needs_review;

-- --------------------------------------------------------- staff self-read --
-- The admin UI needs to know its own role to render. `has_role` is SECURITY
-- DEFINER so it already bypasses RLS; this exposes the role to the session.
create or replace function my_staff_role()
returns staff_role
language sql
stable
security definer
set search_path = public
as $$
  select role from staff_users where user_id = auth.uid();
$$;

-- ----------------------------------------------------------- theme activation --
-- Switching the active theme must be atomic: themes_single_active is a partial
-- unique index, so clearing and setting in two statements races.
--
-- The actor is passed EXPLICITLY rather than read from auth.uid(). Route
-- Handlers connect with the service role, where there is no JWT and auth.uid()
-- is always null — a has_role() check here would reject every legitimate call
-- and give a false sense of protection. The RLS policies that do use
-- auth.uid() apply to anon/authenticated key access, which is a different
-- path. See the README section "Two access paths, two mechanisms".
create or replace function activate_theme(p_theme_id uuid, p_actor uuid)
returns themes
language plpgsql
security definer
set search_path = public
as $$
declare v_row themes;
begin
  if not exists (
    select 1 from staff_users where user_id = p_actor and role = 'admin'
  ) then
    raise exception 'FORBIDDEN:%', p_actor using errcode = 'P0001';
  end if;

  update themes set is_active = false where is_active and id <> p_theme_id;
  update themes set is_active = true, updated_at = now()
   where id = p_theme_id
  returning * into v_row;

  if not found then
    raise exception 'THEME_NOT_FOUND:%', p_theme_id using errcode = 'P0002';
  end if;
  return v_row;
end
$$;
