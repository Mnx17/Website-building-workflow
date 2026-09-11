-- 0003_rls.sql
-- Row level security. The storefront's anon key may read the active catalogue
-- and nothing else; every write goes through a Route Handler holding the
-- service-role key, or through a SECURITY DEFINER function above.

create or replace function has_role(roles staff_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_users s
     where s.user_id = auth.uid() and s.role = any(roles)
  );
$$;

alter table themes                   enable row level security;
alter table staff_users              enable row level security;
alter table products                 enable row level security;
alter table raw_materials            enable row level security;
alter table composite_products       enable row level security;
alter table composite_slots          enable row level security;
alter table composite_configurations enable row level security;
alter table inventory_ledger         enable row level security;
alter table shipping_zones           enable row level security;
alter table shipping_rates           enable row level security;
alter table orders                   enable row level security;
alter table order_items              enable row level security;
alter table gift_orders              enable row level security;

-- carts / cart_items / webhook_events carry NO policies on purpose: RLS is on
-- and nothing matches, so they are unreachable except via the service role.
-- Cart pricing must never be mutable from the browser.
alter table carts          enable row level security;
alter table cart_items     enable row level security;
alter table webhook_events enable row level security;

-- ------------------------------------------------------------ public reads --

create policy products_public_read   on products             for select using (is_active);
create policy materials_public_read  on raw_materials        for select using (is_active);
create policy composites_public_read on composite_products   for select using (is_active);
create policy slots_public_read      on composite_slots      for select using (true);
create policy theme_public_read      on themes               for select using (is_active);
create policy zones_public_read      on shipping_zones       for select using (true);
create policy rates_public_read      on shipping_rates       for select using (true);

-- A configuration is an opaque, hash-addressed build; readable so a shared
-- link can render, but only ever written through upsert_configuration().
create policy configurations_public_read on composite_configurations
  for select using (true);

-- ----------------------------------------------------------- staff writes --

create policy products_write on products
  for all using (has_role('{admin,editor}')) with check (has_role('{admin,editor}'));

create policy materials_write on raw_materials
  for all using (has_role('{admin,editor}')) with check (has_role('{admin,editor}'));

create policy composites_write on composite_products
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

create policy slots_write on composite_slots
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

create policy theme_write on themes
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

create policy zones_write on shipping_zones
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

create policy rates_write on shipping_rates
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

create policy staff_read on staff_users
  for select using (user_id = auth.uid() or has_role('{admin}'));

create policy staff_write on staff_users
  for all using (has_role('{admin}')) with check (has_role('{admin}'));

-- ---------------------------------------------------------------- orders --

create policy orders_read on orders
  for select using (
    user_id = auth.uid() or has_role('{admin,editor,fulfillment}')
  );

create policy orders_staff_update on orders
  for update using (has_role('{admin,fulfillment}'))
          with check (has_role('{admin,fulfillment}'));

create policy order_items_read on order_items
  for select using (
    has_role('{admin,editor,fulfillment}')
    or exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid())
  );

-- Recipient PII: buyer and staff only.
create policy gift_orders_read on gift_orders
  for select using (
    has_role('{admin,fulfillment}')
    or exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid())
  );

-- ---------------------------------------------------------------- ledger --
-- Staff may read the audit trail; inserts happen only inside SECURITY DEFINER
-- functions, and UPDATE/DELETE are already blocked by rules in 0001.

create policy ledger_read on inventory_ledger
  for select using (has_role('{admin,editor,fulfillment}'));
