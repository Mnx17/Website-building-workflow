import { itemHandlers } from '@/lib/admin/route-factory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = itemHandlers({
  entity: 'raw_materials',
  read: ['admin', 'editor', 'fulfillment'],
  write: ['admin', 'editor'],
});

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
