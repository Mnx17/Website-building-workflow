import { collectionHandlers } from '@/lib/admin/route-factory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = collectionHandlers({
  entity: 'raw_materials',
  read: ['admin', 'editor', 'fulfillment'],
  write: ['admin', 'editor'],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
