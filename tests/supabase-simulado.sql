-- Simula o que o Supabase ja fornece (papeis, esquema auth, auth.uid() e pgcrypto) num PostgreSQL de teste.
-- Usado por tests/backup-restauracao.sh e tests/convites-db.sh.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table auth.users (id uuid primary key, email text, created_at timestamptz not null default now());
create table auth.identities (id uuid primary key, user_id uuid references auth.users(id));
create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant usage on schema public to service_role;
-- No Supabase, a service_role (usada so no servidor) tem acesso total as tabelas do esquema public.
alter default privileges in schema public grant all on tables to service_role;
