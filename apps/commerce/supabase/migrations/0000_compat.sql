-- 0000_compat.sql
-- Supabase compatibility shim so the remaining migrations run unmodified on a
-- plain PostgreSQL 15 instance (local dev, CI, integration tests).
--
-- On a real Supabase project the `auth` schema, `auth.users` and `auth.uid()`
-- already exist; every statement here is guarded so this migration is a no-op
-- there. In particular we must NEVER replace Supabase's own `auth.uid()`.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- required by the GIST EXCLUDE on shipping_rates

create schema if not exists auth;

do $do$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'auth' and tablename = 'users'
  ) then
    create table auth.users (
      id    uuid primary key default gen_random_uuid(),
      email text unique
    );
  end if;

  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$;
    $fn$;
  end if;
end
$do$;
