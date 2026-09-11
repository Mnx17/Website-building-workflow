-- 0001_schema.sql
-- Core commerce schema.
--
-- Conventions:
--   * Money is ALWAYS integer baisa (bigint). 1 OMR = 1000 baisa. No floats, ever.
--   * Weight is ALWAYS integer grams.
--   * Bilingual content lives in paired *_en / *_ar columns (Arabic is not optional).

create type composite_kind as enum ('box', 'bouquet');

create type order_status as enum (
  'pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'
);

create type ledger_reason as enum (
  'reserve', 'release', 'commit', 'restock', 'manual_adjust', 'spoilage'
);

create type staff_role as enum ('admin', 'editor', 'fulfillment');

-- ---------------------------------------------------------------- branding --

create table themes (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  logo_url        text,
  primary_color   text not null default '#1F3B2C' check (primary_color   ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text not null default '#E8B84B' check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  font_family     text not null default 'Tajawal',
  is_active       boolean not null default false,
  updated_at      timestamptz not null default now()
);
-- At most one active theme, enforced by the database rather than by app code.
create unique index themes_single_active on themes (is_active) where is_active;

create table staff_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       staff_role not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- catalogue --

create table products (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name_en        text not null,
  name_ar        text not null,
  description_en text,
  description_ar text,
  image_urls     text[] not null default '{}',
  price_baisa    bigint  not null check (price_baisa >= 0),
  weight_grams   integer not null check (weight_grams > 0),
  stock_qty      integer not null default 0 check (stock_qty >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
create index products_active_idx on products (is_active) where is_active;

create table raw_materials (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text not null unique,
  name_en             text not null,
  name_ar             text not null,
  category            text not null,                 -- 'citrus' | 'chocolate' | 'rose' | ...
  image_url           text,
  model_url           text,                          -- GLB in Supabase Storage
  color_hex           text check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  unit_price_baisa    bigint  not null check (unit_price_baisa >= 0),
  weight_grams        integer not null check (weight_grams > 0),
  stock_qty           integer not null default 0 check (stock_qty >= 0),
  reserved_qty        integer not null default 0 check (reserved_qty >= 0),
  low_stock_threshold integer not null default 10,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  -- Last line of defence: if this ever fires in production, some code path
  -- bypassed reserve_configuration().
  constraint raw_materials_reserved_lte_stock check (reserved_qty <= stock_qty)
);
create index raw_materials_category_idx on raw_materials (category) where is_active;
create index raw_materials_low_stock_idx on raw_materials ((stock_qty - reserved_qty)) where is_active;

create table composite_products (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique,
  kind              composite_kind not null,
  name_en           text not null,
  name_ar           text not null,
  base_price_baisa  bigint  not null default 0 check (base_price_baisa >= 0),
  base_weight_grams integer not null default 0 check (base_weight_grams >= 0),
  model_url         text not null,
  slot_count        integer not null check (slot_count between 1 and 12),
  min_filled_slots  integer not null default 1 check (min_filled_slots >= 0),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint fill_rules_sane check (min_filled_slots <= slot_count),
  constraint kind_slot_count check (
    (kind = 'box'     and slot_count = 4) or
    (kind = 'bouquet' and slot_count between 6 and 8)
  )
);

create table composite_slots (
  id                   uuid primary key default gen_random_uuid(),
  composite_product_id uuid not null references composite_products(id) on delete cascade,
  slot_index           integer not null check (slot_index >= 0),
  label_en             text,
  label_ar             text,
  -- 3D placement. Slot ORDER comes from this vector, never from DOM order, so
  -- an RTL locale cannot scramble the configurator.
  position             jsonb not null,               -- {"x":0,"y":0.12,"z":-0.05,"ry":0.78}
  allowed_categories   text[] not null default '{}', -- empty array = any category
  max_qty              integer not null default 1 check (max_qty >= 1),
  is_required          boolean not null default false,
  unique (composite_product_id, slot_index),
  constraint position_is_object check (jsonb_typeof(position) = 'object')
);

create table composite_configurations (
  id                   uuid primary key default gen_random_uuid(),
  composite_product_id uuid not null references composite_products(id) on delete restrict,
  -- [{"slot_index":0,"raw_material_id":"<uuid>","qty":1}, ...]
  slot_map             jsonb not null,
  -- sha256 over the canonical (sorted) slot_map; dedupes identical builds.
  config_hash          text not null,
  unit_price_baisa     bigint  not null check (unit_price_baisa >= 0),
  total_weight_grams   integer not null check (total_weight_grams > 0),
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint slot_map_is_array check (jsonb_typeof(slot_map) = 'array')
);
create unique index composite_configurations_hash_idx
  on composite_configurations (composite_product_id, config_hash);
create index composite_configurations_slotmap_gin
  on composite_configurations using gin (slot_map);

-- ---------------------------------------------------------------- inventory --

-- Append-only. Two independent axes so the ledger reconciles EXACTLY:
--   raw_materials.stock_qty    = sum(delta_stock_qty)
--   raw_materials.reserved_qty = sum(delta_reserved_qty)
-- A single signed column cannot express this, because a reservation moves
-- reserved_qty without moving stock_qty, and a commit moves both.
create table inventory_ledger (
  id                 bigserial primary key,
  raw_material_id    uuid not null references raw_materials(id) on delete restrict,
  delta_stock_qty    integer not null default 0,
  delta_reserved_qty integer not null default 0,
  reason             ledger_reason not null,
  -- Deliberately NOT foreign keys: the audit trail must outlive the cart.
  cart_id            uuid,
  order_id           uuid,
  actor_user_id      uuid references auth.users(id) on delete set null,
  note               text,
  created_at         timestamptz not null default now(),
  constraint ledger_row_does_something check (delta_stock_qty <> 0 or delta_reserved_qty <> 0)
);
create index inventory_ledger_material_idx on inventory_ledger (raw_material_id, created_at desc);
create index inventory_ledger_order_idx    on inventory_ledger (order_id) where order_id is not null;
create index inventory_ledger_cart_idx     on inventory_ledger (cart_id)  where cart_id  is not null;

-- Append-only enforcement. DO INSTEAD NOTHING silently discards the write,
-- which is what we want: no code path should ever mutate history.
create rule inventory_ledger_no_update as on update to inventory_ledger do instead nothing;
create rule inventory_ledger_no_delete as on delete to inventory_ledger do instead nothing;

-- --------------------------------------------------------------------- cart --

create table carts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete set null,
  anon_token     text,
  currency       char(3) not null default 'OMR',
  reserved_until timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint cart_has_an_owner check (user_id is not null or anon_token is not null)
);
create index carts_anon_idx   on carts (anon_token) where anon_token is not null;
create index carts_expiry_idx on carts (reserved_until) where reserved_until is not null;

-- Polymorphic line item: a standard product XOR a composite configuration.
create table cart_items (
  id                uuid primary key default gen_random_uuid(),
  cart_id           uuid not null references carts(id) on delete cascade,
  product_id        uuid references products(id) on delete restrict,
  configuration_id  uuid references composite_configurations(id) on delete restrict,
  qty               integer not null check (qty > 0),
  unit_price_baisa  bigint  not null check (unit_price_baisa >= 0),
  unit_weight_grams integer not null check (unit_weight_grams > 0),
  created_at        timestamptz not null default now(),
  constraint cart_item_exactly_one check (num_nonnulls(product_id, configuration_id) = 1)
);
create unique index cart_items_dedupe_product on cart_items (cart_id, product_id)
  where product_id is not null;
create unique index cart_items_dedupe_config on cart_items (cart_id, configuration_id)
  where configuration_id is not null;

-- ----------------------------------------------------------------- shipping --

create table shipping_zones (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,           -- 'MUSCAT' | 'BATINAH_N' | 'INTL_GCC' | ...
  name_en      text not null,
  name_ar      text not null,
  governorates text[] not null default '{}',
  is_fallback  boolean not null default false,
  cod_enabled  boolean not null default true
);
create unique index shipping_zones_one_fallback on shipping_zones (is_fallback) where is_fallback;

create table shipping_rates (
  id          uuid primary key default gen_random_uuid(),
  zone_id     uuid not null references shipping_zones(id) on delete cascade,
  min_grams   integer not null check (min_grams >= 0),
  max_grams   integer not null check (max_grams > 0),
  price_baisa bigint  not null check (price_baisa >= 0),
  constraint band_valid check (max_grams > min_grams),
  -- Overlapping weight bands within a zone are the classic source of wrong
  -- shipping quotes. Make them physically impossible.
  constraint shipping_rates_no_overlap exclude using gist (
    zone_id with =,
    int4range(min_grams, max_grams, '[)') with &&
  )
);

-- ------------------------------------------------------------------- orders --

create sequence order_number_seq start 1000;

create table orders (
  id                        uuid primary key default gen_random_uuid(),
  order_number              text not null unique
                              default 'SW-' || to_char(now(), 'YYYY') || '-' ||
                                       lpad(nextval('order_number_seq')::text, 6, '0'),
  user_id                   uuid references auth.users(id) on delete set null,
  status                    order_status not null default 'pending',
  currency                  char(3) not null default 'OMR',
  subtotal_baisa            bigint  not null check (subtotal_baisa >= 0),
  shipping_baisa            bigint  not null default 0 check (shipping_baisa >= 0),
  vat_baisa                 bigint  not null default 0 check (vat_baisa >= 0),
  -- Gateways may require the charged total to be a multiple of 10 baisa. The
  -- delta is persisted here so the invoice reconciles exactly.
  rounding_adjustment_baisa bigint  not null default 0,
  total_baisa               bigint  not null check (total_baisa >= 0),
  total_weight_grams        integer not null check (total_weight_grams >= 0),
  shipping_zone_id          uuid references shipping_zones(id) on delete set null,
  cart_id                   uuid,
  payment_provider          text,
  payment_session_id        text,
  payment_reference         text,
  placed_at                 timestamptz not null default now(),
  paid_at                   timestamptz,
  constraint paid_requires_timestamp check (status <> 'paid' or paid_at is not null),
  constraint totals_reconcile check (
    total_baisa = subtotal_baisa + shipping_baisa + vat_baisa + rounding_adjustment_baisa
  )
);
create index orders_status_idx on orders (status, placed_at desc);
create unique index orders_payment_session_idx on orders (payment_session_id)
  where payment_session_id is not null;

create table order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  product_id        uuid references products(id) on delete set null,
  configuration_id  uuid references composite_configurations(id) on delete set null,
  name_snapshot_en  text not null,
  name_snapshot_ar  text not null,
  slot_map_snapshot jsonb,                      -- frozen BOM for fulfilment
  qty               integer not null check (qty > 0),
  unit_price_baisa  bigint  not null check (unit_price_baisa >= 0),
  unit_weight_grams integer not null check (unit_weight_grams > 0),
  constraint order_item_exactly_one check (num_nonnulls(product_id, configuration_id) = 1)
);
create index order_items_order_idx on order_items (order_id);

create table gift_orders (
  order_id            uuid primary key references orders(id) on delete cascade,
  recipient_name      text not null check (char_length(recipient_name) between 2 and 120),
  recipient_phone     text not null check (recipient_phone ~ '^\+968[79]\d{7}$|^\+\d{8,15}$'),
  delivery_location   text not null,
  delivery_geo        jsonb,                    -- {"lat":23.58,"lng":58.38}
  gift_message        text check (char_length(gift_message) <= 280),
  gift_message_status text not null default 'clean'
                        check (gift_message_status in ('clean', 'flagged', 'rejected')),
  hide_prices         boolean not null default true,
  created_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------- webhooks --

create table webhook_events (
  id           bigserial primary key,
  provider     text not null,
  event_id     text not null,
  signature    text,
  payload      jsonb not null,
  processed_at timestamptz,
  received_at  timestamptz not null default now(),
  -- Replay / duplicate-delivery guard.
  unique (provider, event_id)
);
