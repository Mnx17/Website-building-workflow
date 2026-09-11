import { itemHandlers } from '@/lib/admin/route-factory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = itemHandlers({
  entity: 'composite_products',
  read: ['admin', 'editor', 'fulfillment'],
  write: ['admin'],
});

export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
