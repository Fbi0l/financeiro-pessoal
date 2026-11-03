-- Fase 1: contas, categorias e lançamentos com RLS por usuário
create schema if not exists privado;
revoke all on schema privado from public, anon, authenticated;

create or replace function privado.tocar_atualizado_em()
returns trigger language plpgsql set search_path = '' as $$
begin new.atualizado_em := now(); return new; end; $$;

-- CONTAS
create table public.contas (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null check (char_length(btrim(nome)) between 1 and 60),
  tipo text not null default 'corrente' check (tipo in ('corrente','poupanca','carteira','investimento','outro')),
  saldo_inicial numeric(14,2) not null default 0,
  cor text not null default '#2764e7' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  arquivada boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (id, usuario_id)
);
create unique index contas_nome_unico on public.contas (usuario_id, lower(btrim(nome)));

-- CATEGORIAS
create table public.categorias (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null check (char_length(btrim(nome)) between 1 and 40),
  tipo text not null check (tipo in ('receita','despesa')),
  cor text not null default '#6d7b8f' check (cor ~ '^#[0-9a-fA-F]{6}$'),
  arquivada boolean not null default false,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (id, usuario_id)
);
create unique index categorias_nome_unico on public.categorias (usuario_id, tipo, lower(btrim(nome)));

-- LANÇAMENTOS (receita, despesa ou transferência entre contas)
create table public.lancamentos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('receita','despesa','transferencia')),
  descricao text not null check (char_length(btrim(descricao)) between 1 and 120),
  valor numeric(14,2) not null check (valor > 0),
  data date not null default current_date,
  conta_id uuid not null,
  conta_destino_id uuid,
  categoria_id uuid,
  pago boolean not null default true,
  observacoes text check (observacoes is null or char_length(observacoes) <= 1000),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  -- chaves compostas impedem referenciar conta/categoria de outro usuário
  foreign key (conta_id, usuario_id) references public.contas (id, usuario_id) on delete restrict,
  foreign key (conta_destino_id, usuario_id) references public.contas (id, usuario_id) on delete restrict,
  foreign key (categoria_id, usuario_id) references public.categorias (id, usuario_id) on delete restrict,
  constraint transferencia_consistente check (
    (tipo = 'transferencia' and conta_destino_id is not null and conta_destino_id <> conta_id and categoria_id is null)
    or (tipo <> 'transferencia' and conta_destino_id is null)
  )
);
create index lancamentos_usuario_data on public.lancamentos (usuario_id, data desc);
create index lancamentos_conta on public.lancamentos (conta_id, usuario_id);
create index lancamentos_conta_destino on public.lancamentos (conta_destino_id, usuario_id);
create index lancamentos_categoria on public.lancamentos (categoria_id, usuario_id);

create trigger contas_atualizado before update on public.contas for each row execute function privado.tocar_atualizado_em();
create trigger categorias_atualizado before update on public.categorias for each row execute function privado.tocar_atualizado_em();
create trigger lancamentos_atualizado before update on public.lancamentos for each row execute function privado.tocar_atualizado_em();

-- RLS: cada usuário só enxerga e altera os próprios registros
alter table public.contas enable row level security;
alter table public.categorias enable row level security;
alter table public.lancamentos enable row level security;

do $$
declare t text;
begin
  foreach t in array array['contas','categorias','lancamentos'] loop
    execute format('create policy "%1$s_select" on public.%1$I for select to authenticated using (usuario_id = (select auth.uid()))', t);
    execute format('create policy "%1$s_insert" on public.%1$I for insert to authenticated with check (usuario_id = (select auth.uid()))', t);
    execute format('create policy "%1$s_update" on public.%1$I for update to authenticated using (usuario_id = (select auth.uid())) with check (usuario_id = (select auth.uid()))', t);
    execute format('create policy "%1$s_delete" on public.%1$I for delete to authenticated using (usuario_id = (select auth.uid()))', t);
  end loop;
end $$;

revoke all on public.contas, public.categorias, public.lancamentos from anon;
grant select, insert, update, delete on public.contas, public.categorias, public.lancamentos to authenticated;

-- Saldo atual por conta (respeita RLS de quem consulta)
create view public.saldos_contas with (security_invoker = true) as
select c.id, c.nome, c.tipo, c.cor, c.arquivada, c.saldo_inicial,
  c.saldo_inicial
  + coalesce(sum(case
      when l.pago and l.tipo = 'receita' and l.conta_id = c.id then l.valor
      when l.pago and l.tipo = 'despesa' and l.conta_id = c.id then -l.valor
      when l.pago and l.tipo = 'transferencia' and l.conta_id = c.id then -l.valor
      when l.pago and l.tipo = 'transferencia' and l.conta_destino_id = c.id then l.valor
      else 0 end), 0) as saldo_atual
from public.contas c
left join public.lancamentos l on l.usuario_id = c.usuario_id and (l.conta_id = c.id or l.conta_destino_id = c.id)
group by c.id;
revoke all on public.saldos_contas from anon;
grant select on public.saldos_contas to authenticated;

-- Resumo de um período: saldo anterior, entradas, saídas e saldo final (transferências não contam como entrada/saída)
create or replace function public.resumo_periodo(p_inicio date, p_fim date)
returns table (saldo_anterior numeric, receitas numeric, despesas numeric, saldo_final numeric, pendente_receber numeric, pendente_pagar numeric)
language sql stable security invoker set search_path = '' as $$
  with base as (
    select coalesce(sum(saldo_inicial), 0) as inicial from public.contas where not arquivada
  ), mov as (
    select
      coalesce(sum(case when pago and data < p_inicio and tipo = 'receita' then valor when pago and data < p_inicio and tipo = 'despesa' then -valor else 0 end), 0) as antes,
      coalesce(sum(case when pago and data between p_inicio and p_fim and tipo = 'receita' then valor else 0 end), 0) as rec,
      coalesce(sum(case when pago and data between p_inicio and p_fim and tipo = 'despesa' then valor else 0 end), 0) as desp,
      coalesce(sum(case when not pago and data between p_inicio and p_fim and tipo = 'receita' then valor else 0 end), 0) as prec,
      coalesce(sum(case when not pago and data between p_inicio and p_fim and tipo = 'despesa' then valor else 0 end), 0) as ppag
    from public.lancamentos l
    where exists (select 1 from public.contas c where c.id = l.conta_id and not c.arquivada)
  )
  select b.inicial + m.antes, m.rec, m.desp, b.inicial + m.antes + m.rec - m.desp, m.prec, m.ppag
  from base b, mov m;
$$;
revoke all on function public.resumo_periodo(date, date) from public, anon;
grant execute on function public.resumo_periodo(date, date) to authenticated;

-- Categorias e contas padrão para cada novo usuário
create or replace function privado.criar_padroes_usuario()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categorias (usuario_id, nome, tipo, cor) values
    (new.id, 'Salário', 'receita', '#18794e'),
    (new.id, '13º / Férias', 'receita', '#2e9e6a'),
    (new.id, 'Pix recebido', 'receita', '#4caf87'),
    (new.id, 'Outras receitas', 'receita', '#7cc3a0'),
    (new.id, 'Alimentação', 'despesa', '#e8590c'),
    (new.id, 'Supermercado', 'despesa', '#f08c00'),
    (new.id, 'Transporte', 'despesa', '#1971c2'),
    (new.id, 'Moradia', 'despesa', '#5f3dc4'),
    (new.id, 'Educação', 'despesa', '#0c8599'),
    (new.id, 'Celular e internet', 'despesa', '#3b5bdb'),
    (new.id, 'Assinaturas', 'despesa', '#9c36b5'),
    (new.id, 'Lazer', 'despesa', '#d6336c'),
    (new.id, 'Saúde', 'despesa', '#c92a2a'),
    (new.id, 'Compras', 'despesa', '#e67700'),
    (new.id, 'Família', 'despesa', '#a61e4d'),
    (new.id, 'Outras despesas', 'despesa', '#6d7b8f');
  insert into public.contas (usuario_id, nome, tipo, cor) values
    (new.id, 'Nubank', 'corrente', '#8a05be'),
    (new.id, 'Itaú', 'corrente', '#ec7000'),
    (new.id, 'Banpará', 'corrente', '#0b5394'),
    (new.id, 'Espécie', 'carteira', '#2f9e44');
  return new;
end; $$;
revoke all on function privado.criar_padroes_usuario() from public, anon, authenticated;

create trigger ao_criar_usuario after insert on auth.users
for each row execute function privado.criar_padroes_usuario();
