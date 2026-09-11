-- 0004_cron.sql
-- Schedules the reservation sweep. Guarded so the migration still applies on a
-- plain PostgreSQL instance (CI, integration tests) where pg_cron is absent —
-- there the sweep is driven by the test harness or a platform scheduler.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Re-scheduling the same job name replaces the previous definition.
    perform cron.schedule(
      'release-expired-reservations',
      '* * * * *',
      'select release_expired_reservations()'
    );
  else
    raise notice 'pg_cron unavailable; skipping reservation sweep schedule';
  end if;
end
$do$;
