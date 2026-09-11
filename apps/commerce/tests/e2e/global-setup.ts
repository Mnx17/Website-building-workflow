import postgres from 'postgres';

/**
 * Seeds the staff account the document assertions authenticate as, and resets
 * stock so a previous run's reservations cannot starve this one.
 */
export const E2E_STAFF_ID = '00000000-0000-4000-8000-0000000000e1';

export default async function globalSetup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required for the E2E suite');

  process.env['E2E_STAFF_ID'] = E2E_STAFF_ID;

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`
      insert into auth.users (id, email) values (${E2E_STAFF_ID}, 'e2e-staff@example.com')
      on conflict (id) do nothing
    `;
    await sql`
      insert into staff_users (user_id, role) values (${E2E_STAFF_ID}, 'fulfillment')
      on conflict (user_id) do update set role = excluded.role
    `;
    // Release anything a previous run left held.
    await sql`select release_cart_reservations(id) from carts where reserved_until is not null`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
