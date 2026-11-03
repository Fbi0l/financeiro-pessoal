-- Histórico de importações (versão 0.8.0): cada importação de extrato vira um registro,
-- e os lançamentos dela apontam para ele. Apagar a importação apaga só os lançamentos dela
-- (em uma única operação), para desfazer um extrato importado por engano.
-- Lançamentos manuais nunca têm importação e não são afetados.

create table public.importacoes (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conta_id uuid not null,
  arquivo text not null check (char_length(arquivo) between 1 and 120),
  formato text not null check (char_length(formato) between 1 and 40),
  periodo_inicio date not null,
  periodo_fim date not null,
  criado_em timestamptz not null default now(),
  check (periodo_fim >= periodo_inicio),
  unique (id, usuario_id),
  -- Conta excluída (só possível sem lançamentos) leva junto o registro da importação.
  foreign key (conta_id, usuario_id) references public.contas (id, usuario_id) on delete cascade
);
create index importacoes_usuario_criado_idx on public.importacoes (usuario_id, criado_em desc);
create index importacoes_conta_idx on public.importacoes (conta_id, usuario_id);

alter table public.lancamentos add column importacao_id uuid;
-- Chave composta: um lançamento só aponta para importação do mesmo usuário.
-- ON DELETE CASCADE: apagar a importação apaga os lançamentos dela, e nenhum outro.
alter table public.lancamentos
  add constraint lancamentos_importacao_fk foreign key (importacao_id, usuario_id)
    references public.importacoes (id, usuario_id) on delete cascade,
  add constraint lancamentos_importacao_so_importados check (importacao_id is null or origem = 'importacao');
create index lancamentos_importacao_idx on public.lancamentos (importacao_id) where importacao_id is not null;

-- Regras de acesso: cada um só vê, cria e apaga as próprias importações. Não há edição.
alter table public.importacoes enable row level security;
create policy importacoes_select on public.importacoes for select to authenticated using (usuario_id = (select auth.uid()));
create policy importacoes_insert on public.importacoes for insert to authenticated with check (usuario_id = (select auth.uid()));
create policy importacoes_delete on public.importacoes for delete to authenticated using (usuario_id = (select auth.uid()));
revoke all on public.importacoes from public, anon, authenticated;
grant select, insert, delete on public.importacoes to authenticated;

-- Resumo para a lista "Importações recentes": quantos lançamentos ainda restam e os totais.
create view public.importacoes_resumo with (security_invoker = true) as
  select i.id, i.conta_id, i.arquivo, i.formato, i.periodo_inicio, i.periodo_fim, i.criado_em,
         count(l.id)::int as quantidade,
         coalesce(sum(l.valor) filter (where l.tipo = 'receita'), 0) as entradas,
         coalesce(sum(l.valor) filter (where l.tipo = 'despesa'), 0) as saidas
  from public.importacoes i
  left join public.lancamentos l on l.importacao_id = i.id and l.usuario_id = i.usuario_id
  group by i.id;
revoke all on public.importacoes_resumo from public, anon, authenticated;
grant select on public.importacoes_resumo to authenticated;

-- Importações feitas antes desta versão: ganham um registro para também poderem ser apagadas.
-- Cada importação grava os lançamentos juntos (no mesmo minuto), então o agrupamento é por
-- pessoa, conta e minuto da gravação. Nenhum valor de lançamento muda.
with grupos as (
  select usuario_id, conta_id, date_trunc('minute', criado_em) as minuto,
         min(data) as inicio, max(data) as fim, min(criado_em) as criado
  from public.lancamentos
  where origem = 'importacao' and importacao_id is null
  group by usuario_id, conta_id, date_trunc('minute', criado_em)
), novos as (
  insert into public.importacoes (usuario_id, conta_id, arquivo, formato, periodo_inicio, periodo_fim, criado_em)
  select usuario_id, conta_id, 'Importação anterior', 'Extrato', inicio, fim, criado from grupos
  returning id, usuario_id, conta_id, criado_em
)
update public.lancamentos l set importacao_id = n.id
from novos n
where l.origem = 'importacao' and l.importacao_id is null
  and l.usuario_id = n.usuario_id and l.conta_id = n.conta_id
  and date_trunc('minute', l.criado_em) = date_trunc('minute', n.criado_em);
