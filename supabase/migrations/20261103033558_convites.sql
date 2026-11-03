-- Convites (versão 0.7.0): só o administrador gera links de uso único para outra pessoa
-- criar a própria conta, com finanças separadas (as regras de acesso por usuário não mudam).

-- 1) Administrador: o titular, o primeiro usuário do projeto. Fica no esquema privado (fora da API).
create table privado.administradores (
  usuario_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);
insert into privado.administradores (usuario_id)
select id from auth.users order by created_at limit 1;

-- 2) Convites. Guarda só o "hash" (impressão digital SHA-256) do código: o link em si nunca fica no banco.
create table public.convites (
  id uuid primary key default gen_random_uuid(),
  criado_por uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rotulo text check (rotulo is null or char_length(btrim(rotulo)) between 1 and 40),
  codigo_hash text not null unique check (codigo_hash ~ '^[0-9a-f]{64}$'),
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '48 hours',
  usado_em timestamptz,
  usado_por uuid references auth.users(id) on delete set null,
  cancelado_em timestamptz,
  check (expira_em > criado_em)
);
alter table public.convites enable row level security;
-- Ninguém do app lê ou grava a tabela direto: só pelas funções abaixo (administrador)
-- e pela função de cadastro no servidor (service_role).
revoke all on public.convites from public, anon, authenticated;

create or replace function public.sou_administrador()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from privado.administradores a where a.usuario_id = (select auth.uid()));
$$;

create or replace function public.criar_convite(p_rotulo text default null)
returns table (id uuid, codigo text, expira_em timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_codigo text; v_rotulo text := nullif(btrim(coalesce(p_rotulo, '')), '');
begin
  if not public.sou_administrador() then
    raise exception 'Somente o administrador pode convidar pessoas.' using errcode = '42501';
  end if;
  if v_rotulo is not null and char_length(v_rotulo) > 40 then
    raise exception 'O apelido pode ter no máximo 40 caracteres.' using errcode = '22023';
  end if;
  if (select count(*) from public.convites c where c.criado_por = (select auth.uid())
        and c.usado_em is null and c.cancelado_em is null and c.expira_em > now()) >= 10 then
    raise exception 'Há 10 convites pendentes. Cancele algum antes de gerar outro.' using errcode = '54000';
  end if;
  -- 32 bytes aleatórios em base64url: 43 caracteres, impossível de adivinhar.
  v_codigo := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  return query
    insert into public.convites (criado_por, rotulo, codigo_hash)
    values ((select auth.uid()), v_rotulo, encode(sha256(convert_to(v_codigo, 'UTF8')), 'hex'))
    returning convites.id, v_codigo, convites.expira_em;
end; $$;

create or replace function public.listar_convites()
returns table (id uuid, rotulo text, criado_em timestamptz, expira_em timestamptz, usado_em timestamptz, situacao text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.sou_administrador() then
    raise exception 'Somente o administrador pode ver os convites.' using errcode = '42501';
  end if;
  return query
    select c.id, c.rotulo, c.criado_em, c.expira_em, c.usado_em,
      case when c.usado_em is not null and c.usado_por is not null then 'usado'
           when c.cancelado_em is not null then 'cancelado'
           when c.expira_em <= now() then 'vencido'
           when c.usado_em is not null then 'em_uso'
           else 'pendente' end
    from public.convites c
    where c.criado_por = (select auth.uid())
    order by c.criado_em desc
    limit 50;
end; $$;

create or replace function public.cancelar_convite(p_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  if not public.sou_administrador() then
    raise exception 'Somente o administrador pode cancelar convites.' using errcode = '42501';
  end if;
  update public.convites c set cancelado_em = now()
   where c.id = p_id and c.criado_por = (select auth.uid())
     and c.usado_em is null and c.cancelado_em is null and c.expira_em > now();
  get diagnostics n = row_count;
  return n > 0;
end; $$;

revoke all on function public.sou_administrador(), public.criar_convite(text), public.listar_convites(), public.cancelar_convite(uuid) from public, anon;
grant execute on function public.sou_administrador(), public.criar_convite(text), public.listar_convites(), public.cancelar_convite(uuid) to authenticated;
