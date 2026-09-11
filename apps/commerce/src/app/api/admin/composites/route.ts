import { collectionHandlers } from '@/lib/admin/route-factory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Composite templates define slot rules that gate every build, so only an
// admin may change them.
const handlers = collectionHandlers({
  entity: 'composite_products',
  read: ['admin', 'editor', 'fulfillment'],
  write: ['admin'],
});

export const GET = handlers.GET;
export const POST = handlers.POST;
