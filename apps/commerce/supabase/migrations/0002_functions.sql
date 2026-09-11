-- 0002_functions.sql
-- Authoritative pricing, inventory reservation/commit, and order-state guards.
--
-- Everything that touches money or stock lives here rather than in application
-- code, so a bug in a Route Handler (or a second consumer written later)
-- cannot oversell stock or invent a price.

create type configuration_pricing as (
  unit_price_baisa   bigint,
  total_weight_grams integer,
  filled_slots       integer
);

-- ---------------------------------------------------------------------------
-- price_configuration
--   Validates a slot map against the composite template and recomputes price
--   and weight from raw_materials. Read-only, so the debounced price endpoint
--   can call it on every keystroke without writing a row.
--   This is the single source of truth for what a build costs; the client's
--   own estimate is never trusted.
-- ---------------------------------------------------------------------------
create or replace function price_configuration(
  p_composite_product_id uuid,
  p_slot_map             jsonb
) returns configuration_pricing
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product     composite_products;
  v_price       bigint  := 0;
  v_weight      integer := 0;
  v_filled      integer := 0;
  v_out         configuration_pricing;
  e             jsonb;
  v_slot        composite_slots;
  v_material    raw_materials;
  v_qty         integer;
  v_slot_index  integer;
  v_seen        integer[] := '{}';
begin
  if jsonb_typeof(p_slot_map) <> 'array' then
    raise exception 'SLOT_MAP_NOT_ARRAY' using errcode = '22023';
  end if;

  select * into v_product
    from composite_products
   where id = p_composite_product_id and is_active;
  if not found then
    raise exception 'COMPOSITE_NOT_FOUND:%', p_composite_product_id using errcode = 'P0002';
  end if;

  v_price  := v_product.base_price_baisa;
  v_weight := v_product.base_weight_grams;

  for e in select * from jsonb_array_elements(p_slot_map)
  loop
    if e->>'slot_index' is null or e->>'raw_material_id' is null then
      raise exception 'SLOT_ENTRY_MALFORMED' using errcode = '22023';
    end if;

    v_slot_index := (e->>'slot_index')::integer;
    v_qty        := coalesce((e->>'qty')::integer, 1);

    if v_slot_index = any(v_seen) then
      raise exception 'DUPLICATE_SLOT:%', v_slot_index using errcode = '22023';
    end if;
    v_seen := v_seen || v_slot_index;

    select * into v_slot
      from composite_slots
     where composite_product_id = p_composite_product_id
       and slot_index = v_slot_index;
    if not found then
      raise exception 'SLOT_NOT_FOUND:%', v_slot_index using errcode = 'P0002';
    end if;

    if v_qty < 1 or v_qty > v_slot.max_qty then
      raise exception 'SLOT_QTY_OUT_OF_RANGE:%', v_slot_index using errcode = '22023';
    end if;

    select * into v_material
      from raw_materials
     where id = (e->>'raw_material_id')::uuid and is_active;
    if not found then
      raise exception 'MATERIAL_NOT_FOUND:%', e->>'raw_material_id' using errcode = 'P0002';
    end if;

    if array_length(v_slot.allowed_categories, 1) is not null
       and not (v_material.category = any(v_slot.allowed_categories)) then
      raise exception 'CATEGORY_NOT_ALLOWED:%:%', v_slot_index, v_material.category
        using errcode = '22023';
    end if;

    v_price  := v_price  + v_material.unit_price_baisa * v_qty;
    v_weight := v_weight + v_material.weight_grams     * v_qty;
    v_filled := v_filled + 1;
  end loop;

  if v_filled < v_product.min_filled_slots then
    raise exception 'MIN_FILL_NOT_MET:%:%', v_filled, v_product.min_filled_slots
      using errcode = '22023';
  end if;

  -- Every slot flagged is_required must appear in the map.
  if exists (
    select 1 from composite_slots s
     where s.composite_product_id = p_composite_product_id
       and s.is_required
       and not (s.slot_index = any(v_seen))
  ) then
    raise exception 'REQUIRED_SLOT_EMPTY' using errcode = '22023';
  end if;

  v_out.unit_price_baisa   := v_price;
  v_out.total_weight_grams := v_weight;
  v_out.filled_slots       := v_filled;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- upsert_configuration
--   Prices the build via price_configuration (so validation lives in exactly
--   one place) and dedupes identical builds on (composite_product_id, hash).
-- ---------------------------------------------------------------------------
create or replace function upsert_configuration(
  p_composite_product_id uuid,
  p_slot_map             jsonb,
  p_config_hash          text,
  p_created_by           uuid default null
) returns composite_configurations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_priced configuration_pricing;
  v_row    composite_configurations;
begin
  v_priced := price_configuration(p_composite_product_id, p_slot_map);

  insert into composite_configurations (
    composite_product_id, slot_map, config_hash,
    unit_price_baisa, total_weight_grams, created_by
  )
  values (
    p_composite_product_id, p_slot_map, p_config_hash,
    v_priced.unit_price_baisa, v_priced.total_weight_grams, p_created_by
  )
  on conflict (composite_product_id, config_hash) do update
    -- Prices move; refresh the stored snapshot on every re-add.
    set unit_price_baisa   = excluded.unit_price_baisa,
        total_weight_grams = excluded.total_weight_grams
  returning * into v_row;

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- reserve_configuration
--   Reserves the bill of materials for p_qty copies of a configuration.
--   Locks raw materials in raw_material_id order so two carts touching
--   overlapping BOMs in different slot order cannot deadlock.
-- ---------------------------------------------------------------------------
create or replace function reserve_configuration(
  p_cart_id   uuid,
  p_config_id uuid,
  p_qty       integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  if p_qty <= 0 then
    raise exception 'INVALID_QTY:%', p_qty using errcode = '22023';
  end if;

  -- Serialize concurrent mutations of the same cart.
  perform 1 from carts where id = p_cart_id for update;
  if not found then
    raise exception 'CART_NOT_FOUND:%', p_cart_id using errcode = 'P0002';
  end if;

  for r in
    select (e->>'raw_material_id')::uuid        as rm_id,
           sum(coalesce((e->>'qty')::int, 1)) * p_qty as need
      from composite_configurations c,
           lateral jsonb_array_elements(c.slot_map) e
     where c.id = p_config_id
     group by 1
     order by 1                                  -- deterministic lock order
  loop
    perform 1 from raw_materials where id = r.rm_id for update;

    update raw_materials
       set reserved_qty = reserved_qty + r.need
     where id = r.rm_id
       and is_active
       and stock_qty - reserved_qty >= r.need;

    if not found then
      raise exception 'OUT_OF_STOCK:%', r.rm_id using errcode = 'P0001';
    end if;

    insert into inventory_ledger (raw_material_id, delta_reserved_qty, reason, cart_id)
    values (r.rm_id, r.need, 'reserve', p_cart_id);
  end loop;

  update carts
     set reserved_until = now() + interval '30 minutes',
         updated_at     = now()
   where id = p_cart_id;
end
$$;

-- ---------------------------------------------------------------------------
-- release_cart_reservations
--   Reverses whatever the cart still holds. Idempotent: after it runs the
--   cart's net reserved quantity is zero, so a second call is a no-op.
-- ---------------------------------------------------------------------------
create or replace function release_cart_reservations(p_cart_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_count integer := 0;
begin
  for r in
    select raw_material_id as rm_id, sum(delta_reserved_qty) as net
      from inventory_ledger
     where cart_id = p_cart_id
     group by 1
    having sum(delta_reserved_qty) <> 0
     order by 1
  loop
    perform 1 from raw_materials where id = r.rm_id for update;

    update raw_materials
       set reserved_qty = greatest(reserved_qty - r.net, 0)
     where id = r.rm_id;

    insert into inventory_ledger (raw_material_id, delta_reserved_qty, reason, cart_id)
    values (r.rm_id, -r.net, 'release', p_cart_id);

    v_count := v_count + 1;
  end loop;

  update carts set reserved_until = null, updated_at = now() where id = p_cart_id;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- release_expired_reservations
--   Cron entry point. Sweeps carts whose hold has lapsed.
-- ---------------------------------------------------------------------------
create or replace function release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c       record;
  v_carts integer := 0;
begin
  for c in
    select id from carts
     where reserved_until is not null and reserved_until < now()
     order by id
     limit 500
  loop
    perform release_cart_reservations(c.id);
    v_carts := v_carts + 1;
  end loop;
  return v_carts;
end
$$;

-- ---------------------------------------------------------------------------
-- commit_order_stock
--   Converts the cart's reservation into a permanent stock decrement.
--   Idempotent, and returns a status rather than raising on a lost
--   reservation: a webhook that raises would be retried forever.
--   Returns 'committed' | 'already_committed' | 'reservation_lost'.
-- ---------------------------------------------------------------------------
create or replace function commit_order_stock(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cart_id uuid;
  r         record;
  v_any     boolean := false;
begin
  if exists (
    select 1 from inventory_ledger
     where order_id = p_order_id and reason = 'commit'
  ) then
    return 'already_committed';
  end if;

  select cart_id into v_cart_id from orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND:%', p_order_id using errcode = 'P0002';
  end if;
  if v_cart_id is null then
    return 'reservation_lost';
  end if;

  for r in
    select raw_material_id as rm_id, sum(delta_reserved_qty) as net
      from inventory_ledger
     where cart_id = v_cart_id
     group by 1
    having sum(delta_reserved_qty) > 0
     order by 1
  loop
    perform 1 from raw_materials where id = r.rm_id for update;

    update raw_materials
       set stock_qty    = stock_qty    - r.net,
           reserved_qty = reserved_qty - r.net
     where id = r.rm_id;

    insert into inventory_ledger (
      raw_material_id, delta_stock_qty, delta_reserved_qty, reason, cart_id, order_id
    )
    values (r.rm_id, -r.net, -r.net, 'commit', v_cart_id, p_order_id);

    v_any := true;
  end loop;

  if not v_any then
    -- The hold lapsed before payment landed. Caller must flag the order for
    -- manual review rather than silently shipping stock it does not have.
    return 'reservation_lost';
  end if;

  update carts set reserved_until = null, updated_at = now() where id = v_cart_id;
  return 'committed';
end
$$;

-- ---------------------------------------------------------------------------
-- restock_order — reverses a commit on refund/cancellation after payment.
-- ---------------------------------------------------------------------------
create or replace function restock_order(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_count integer := 0;
begin
  if exists (
    select 1 from inventory_ledger where order_id = p_order_id and reason = 'restock'
  ) then
    return 0;
  end if;

  for r in
    select raw_material_id as rm_id, -sum(delta_stock_qty) as qty
      from inventory_ledger
     where order_id = p_order_id and reason = 'commit'
     group by 1
    having -sum(delta_stock_qty) > 0
     order by 1
  loop
    perform 1 from raw_materials where id = r.rm_id for update;
    update raw_materials set stock_qty = stock_qty + r.qty where id = r.rm_id;

    insert into inventory_ledger (raw_material_id, delta_stock_qty, reason, order_id)
    values (r.rm_id, r.qty, 'restock', p_order_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- adjust_stock — the ONLY supported way for admin UI to move stock, so the
-- ledger and raw_materials can never drift apart.
-- ---------------------------------------------------------------------------
create or replace function adjust_stock(
  p_raw_material_id uuid,
  p_delta           integer,
  p_reason          ledger_reason,
  p_note            text default null,
  p_actor           uuid default null
) returns raw_materials
language plpgsql
security definer
set search_path = public
as $$
declare v_row raw_materials;
begin
  if p_delta = 0 then
    raise exception 'ZERO_ADJUSTMENT' using errcode = '22023';
  end if;
  if p_reason not in ('restock', 'manual_adjust', 'spoilage') then
    raise exception 'INVALID_ADJUSTMENT_REASON:%', p_reason using errcode = '22023';
  end if;

  perform 1 from raw_materials where id = p_raw_material_id for update;
  if not found then
    raise exception 'MATERIAL_NOT_FOUND:%', p_raw_material_id using errcode = 'P0002';
  end if;

  update raw_materials
     set stock_qty = stock_qty + p_delta
   where id = p_raw_material_id
  returning * into v_row;

  insert into inventory_ledger (
    raw_material_id, delta_stock_qty, reason, actor_user_id, note
  )
  values (p_raw_material_id, p_delta, p_reason, p_actor, p_note);

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- Order state machine, enforced by trigger so an admin UI bug cannot corrupt
-- state. Transitions not listed here are rejected.
-- ---------------------------------------------------------------------------
create or replace function assert_order_transition()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    return new;
  end if;

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

create trigger orders_assert_transition
  before update of status on orders
  for each row execute function assert_order_transition();
