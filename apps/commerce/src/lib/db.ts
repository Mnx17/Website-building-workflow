import postgres from 'postgres';

/**
 * Server-only Postgres client.
 *
 * `prepare: false` is required when talking to Supabase through the Supavisor
 * TRANSACTION pooler: prepared statements are not shared across pooled
 * sessions and named-statement reuse fails intermittently under load.
 */
let client: postgres.Sql | undefined;

export function getSql(): postgres.Sql {
  if (client) return client;

  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }

  client = postgres(url, {
    prepare: false,
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
    types: {
      // Return int8/numeric as strings, not JS numbers: baisa totals must not
      // be silently coerced through a float.
      bigint: postgres.BigInt,
    },
  });

  return client;
}

export async function closeSql(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}
