-- seed.sql — development / test fixtures.
-- UUIDs are deterministic so integration tests can reference them directly.
--
-- Initial stock is loaded through adjust_stock() rather than an INSERT with a
-- non-zero stock_qty, so the ledger reconciles to raw_materials from the very
-- first row: stock_qty = sum(delta_stock_qty) holds even on a fresh database.

insert into themes (name, logo_url, primary_color, secondary_color, font_family, is_active)
values ('Default', null, '#1F3B2C', '#E8B84B', 'Tajawal', true);

-- ---------------------------------------------------------- raw materials --

insert into raw_materials (id, sku, name_en, name_ar, category, color_hex,
                           unit_price_baisa, weight_grams, low_stock_threshold)
values
  ('11111111-0000-4000-8000-000000000001', 'CIT-ORANGE',  'Candied Orange',   'برتقال مسكر',   'citrus',    '#E8862B',  750, 45, 20),
  ('11111111-0000-4000-8000-000000000002', 'CIT-LEMON',   'Candied Lemon',    'ليمون مسكر',    'citrus',    '#E8D14B',  700, 42, 20),
  ('11111111-0000-4000-8000-000000000003', 'CHO-DARK',    'Dark Chocolate',   'شوكولاتة داكنة', 'chocolate', '#3B2417', 1250, 60, 15),
  ('11111111-0000-4000-8000-000000000004', 'CHO-MILK',    'Milk Chocolate',   'شوكولاتة بالحليب','chocolate', '#8B5E3C', 1150, 60, 15),
  ('11111111-0000-4000-8000-000000000005', 'HAL-CLASSIC', 'Omani Halwa',      'حلوى عمانية',    'halwa',     '#7A4A1E', 1800, 90, 10),
  ('11111111-0000-4000-8000-000000000006', 'DAT-KHALAS',  'Khalas Dates',     'تمر خلاص',      'dates',     '#5C3317',  900, 55, 25),
  ('11111111-0000-4000-8000-000000000007', 'ROS-RED',     'Preserved Rose',   'وردة محفوظة',    'rose',      '#C2185B', 1400, 35, 12),
  ('11111111-0000-4000-8000-000000000008', 'ROS-WHITE',   'White Rose',       'وردة بيضاء',     'rose',      '#F5F0E6', 1400, 35, 12);

select adjust_stock(id, 200, 'restock', 'initial seed load') from raw_materials;

-- --------------------------------------------------------------- products --

insert into products (slug, name_en, name_ar, description_en, description_ar,
                      price_baisa, weight_grams, stock_qty)
values
  ('classic-halwa-tin', 'Classic Halwa Tin', 'علبة الحلوى الكلاسيكية',
   'Traditional Omani halwa in a 500g gift tin.', 'حلوى عمانية تقليدية في علبة هدايا ٥٠٠ غرام.',
   6500, 620, 40),
  ('date-selection-box', 'Date Selection Box', 'صندوق التمور المختارة',
   'Six varieties of Omani dates.', 'ستة أصناف من التمور العمانية.',
   4750, 480, 60);

-- ----------------------------------------------------- composite products --

insert into composite_products (id, slug, kind, name_en, name_ar, base_price_baisa,
                                base_weight_grams, model_url, slot_count, min_filled_slots)
values
  ('22222222-0000-4000-8000-000000000001', 'custom-box-4', 'box',
   'Build Your Own Box', 'صمم صندوقك',
   2500, 180, 'models/box-4slot.draco.glb', 4, 1),
  ('22222222-0000-4000-8000-000000000002', 'rose-bouquet-6', 'bouquet',
   'Sweet Bouquet', 'باقة الحلويات',
   4000, 220, 'models/bouquet-6ring.draco.glb', 6, 3);

-- Box: a 2x2 grid. Any category is allowed in any slot.
insert into composite_slots (composite_product_id, slot_index, label_en, label_ar, position, max_qty)
values
  ('22222222-0000-4000-8000-000000000001', 0, 'Top left',     'أعلى اليسار',  '{"x":-0.05,"y":0.02,"z":-0.05,"ry":0}', 1),
  ('22222222-0000-4000-8000-000000000001', 1, 'Top right',    'أعلى اليمين',  '{"x":0.05,"y":0.02,"z":-0.05,"ry":0}',  1),
  ('22222222-0000-4000-8000-000000000001', 2, 'Bottom left',  'أسفل اليسار',  '{"x":-0.05,"y":0.02,"z":0.05,"ry":0}',  1),
  ('22222222-0000-4000-8000-000000000001', 3, 'Bottom right', 'أسفل اليمين',  '{"x":0.05,"y":0.02,"z":0.05,"ry":0}',   1);

-- Bouquet: six positions on a ring. Two are reserved for roses.
insert into composite_slots (composite_product_id, slot_index, label_en, label_ar,
                             position, allowed_categories, is_required)
values
  ('22222222-0000-4000-8000-000000000002', 0, 'Ring 1', 'الحلقة ١', '{"x":0.00,"y":0.10,"z":0.08,"ry":0.00}',  '{}',       true),
  ('22222222-0000-4000-8000-000000000002', 1, 'Ring 2', 'الحلقة ٢', '{"x":0.07,"y":0.10,"z":0.04,"ry":1.05}',  '{}',       true),
  ('22222222-0000-4000-8000-000000000002', 2, 'Ring 3', 'الحلقة ٣', '{"x":0.07,"y":0.10,"z":-0.04,"ry":2.09}', '{}',       false),
  ('22222222-0000-4000-8000-000000000002', 3, 'Ring 4', 'الحلقة ٤', '{"x":0.00,"y":0.10,"z":-0.08,"ry":3.14}', '{}',       false),
  ('22222222-0000-4000-8000-000000000002', 4, 'Ring 5', 'الحلقة ٥', '{"x":-0.07,"y":0.10,"z":-0.04,"ry":4.19}','{rose}',   false),
  ('22222222-0000-4000-8000-000000000002', 5, 'Ring 6', 'الحلقة ٦', '{"x":-0.07,"y":0.10,"z":0.04,"ry":5.24}', '{rose}',   false);

-- --------------------------------------------------------------- shipping --

insert into shipping_zones (id, code, name_en, name_ar, governorates, is_fallback, cod_enabled)
values
  ('33333333-0000-4000-8000-000000000001', 'MUSCAT', 'Muscat', 'مسقط',
   '{Muscat}', false, true),
  ('33333333-0000-4000-8000-000000000002', 'NORTH', 'Northern Oman', 'شمال عمان',
   '{"Al Batinah North","Al Batinah South","Ad Dakhiliyah","Ad Dhahirah","Al Buraimi","Musandam"}', false, true),
  ('33333333-0000-4000-8000-000000000003', 'SOUTH', 'Southern & Eastern Oman', 'جنوب وشرق عمان',
   '{"Dhofar","Al Wusta","Ash Sharqiyah North","Ash Sharqiyah South"}', false, true),
  ('33333333-0000-4000-8000-000000000004', 'REST', 'Rest of world', 'بقية العالم',
   '{}', true, false);

-- Every zone MUST have a band reaching the top of int4, so a heavy cart can
-- never fall through the lookup and 500 at checkout.
insert into shipping_rates (zone_id, min_grams, max_grams, price_baisa)
values
  ('33333333-0000-4000-8000-000000000001',     0,    1000,  1000),
  ('33333333-0000-4000-8000-000000000001',  1000,    5000,  1500),
  ('33333333-0000-4000-8000-000000000001',  5000, 2147483647, 2500),
  ('33333333-0000-4000-8000-000000000002',     0,    1000,  1500),
  ('33333333-0000-4000-8000-000000000002',  1000,    5000,  2500),
  ('33333333-0000-4000-8000-000000000002',  5000, 2147483647, 4000),
  ('33333333-0000-4000-8000-000000000003',     0,    1000,  2000),
  ('33333333-0000-4000-8000-000000000003',  1000,    5000,  3500),
  ('33333333-0000-4000-8000-000000000003',  5000, 2147483647, 5500),
  ('33333333-0000-4000-8000-000000000004',     0,    5000, 12000),
  ('33333333-0000-4000-8000-000000000004',  5000, 2147483647, 25000);
