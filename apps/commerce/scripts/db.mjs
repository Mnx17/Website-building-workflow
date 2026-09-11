#!/usr/bin/env node
/**
 * Minimal migration runner for local development and CI.
 *
 * Applies every file in supabase/migrations in filename order inside a single
 * transaction per file, recording what ran in schema_migrations. On Supabase
 * itself you would use `supabase db push`; this exists so the integration
 * tests can stand up a plain PostgreSQL 15 container without the CLI.
 *
 *   node scripts/db.mjs migrate
 *   node scripts/db.mjs seed
 *   node scripts/db.mjs reset    # drop public schema, migrate, seed
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'supabase', 'migrations');
const seedFile = join(here, '..', 'supabase', 'seed.sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

async function ensureMigrationsTable() {
  await sql`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `;
}

async function migrate() {
  await ensureMigrationsTable();
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const filename of files) {
    const [existing] = await sql`
      select filename from schema_migrations where filename = ${filename}
    `;
    if (existing) {
      console.log(`  skip   ${filename}`);
      continue;
    }

    const body = await readFile(join(migrationsDir, filename), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename) values (${filename})`;
    });
    console.log(`  apply  ${filename}`);
  }
}

async function seed() {
  const body = await readFile(seedFile, 'utf8');
  await sql.unsafe(body);
  console.log('  seeded');
}

async function reset() {
  // Types and functions live in public; dropping the schema clears everything
  // the migrations create. The auth shim is recreated by 0000.
  await sql.unsafe('drop schema if exists public cascade; create schema public;');
  console.log('  dropped public schema');
  await migrate();
  await seed();
}

const command = process.argv[2] ?? 'migrate';
try {
  if (command === 'migrate') await migrate();
  else if (command === 'seed') await seed();
  else if (command === 'reset') await reset();
  else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
