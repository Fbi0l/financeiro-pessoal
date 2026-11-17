-- Lançar pelo celular (versão 0.14.0): Atalhos do iPhone (e, depois, automação no Android)
-- gravam gastos sem abrir o app, usando uma chave pessoal.
--
-- Segurança:
-- - A chave tem 32 bytes aleatórios (43 caracteres). O banco guarda só o hash SHA-256 dela.
-- - Com a chave, só dá para INCLUIR lançamentos na conta do dono da chave e ver os NOMES das contas dele.
--   Não dá para ler, alterar ou apagar nada.
-- - Limite de 60 lançamentos por chave por dia (dia de Belém); cada pessoa pode ter até 5 chaves ativas.
-- - O dono vê e cancela as próprias chaves no app.

create table privado.chaves_atalho (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  chave_hash text not null unique check (chave_hash ~ '^[0-9a-f]{64}$'),
  apelido text check (apelido is null or char_length(btrim(apelido)) between 1 and 40),
  criada_em timestamptz not null default now(),
  ultimo_uso timestamptz,
  cancelada_em timestamptz,
  uso_dia date,
  uso_qtd integer not null default 0 check (uso_qtd >= 0)
);
create index chaves_atalho_usuario on privado.chaves_atalho (usuario_id);
-- Proteção extra: regras de acesso ligadas (sem políticas, ninguém lê pela API; as funções abaixo são as donas).
alter table privado.chaves_atalho enable row level security;

/* ---------- Funções do dono (logado no app) ---------- */

create function public.criar_chave_atalho(p_apelido text default null)
returns table (id uuid, chave text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_usuario uuid := (select auth.uid());
  v_apelido text := nullif(btrim(coalesce(p_apelido, '')), '');
  v_chave text;
begin
  if v_usuario is null then
    raise exception 'Entre no app para criar a chave.' using errcode = '42501';
  end if;
  if v_apelido is not null and char_length(v_apelido) > 40 then
    raise exception 'O apelido pode ter no máximo 40 caracteres.' using errcode = '22023';
  end if;
  if (select count(*) from privado.chaves_atalho k where k.usuario_id = v_usuario and k.cancelada_em is null) >= 5 then
    raise exception 'Você já tem 5 chaves ativas. Cancele alguma antes de criar outra.' using errcode = '54000';
  end if;
  v_chave := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  return query
    insert into privado.chaves_atalho (usuario_id, chave_hash, apelido)
    values (v_usuario, encode(sha256(convert_to(v_chave, 'UTF8')), 'hex'), v_apelido)
    returning chaves_atalho.id, v_chave;
end; $$;

create function public.listar_chaves_atalho()
returns table (id uuid, apelido text, criada_em timestamptz, ultimo_uso timestamptz)
language sql stable security definer set search_path = '' as $$
  select k.id, k.apelido, k.criada_em, k.ultimo_uso
  from privado.chaves_atalho k
  where k.usuario_id = (select auth.uid()) and k.cancelada_em is null
  order by k.criada_em desc;
$$;

create function public.cancelar_chave_atalho(p_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  update privado.chaves_atalho k set cancelada_em = now()
   where k.id = p_id and k.usuario_id = (select auth.uid()) and k.cancelada_em is null;
  get diagnostics n = row_count;
  return n > 0;
end; $$;

/* ---------- Funções do atalho (sem login: a chave identifica a pessoa) ---------- */

-- Dono de uma chave ativa (interna: não fica na API).
create function privado.dono_da_chave(p_chave text)
returns uuid language sql stable security definer set search_path = '' as $$
  select k.usuario_id from privado.chaves_atalho k
  where k.cancelada_em is null
    and k.chave_hash = encode(sha256(convert_to(coalesce(btrim(p_chave), ''), 'UTF8')), 'hex');
$$;

-- Lê um valor como o celular manda: "R$ 1.234,56", "12,50", "12.50", "-7,5", "1.234".
create function privado.ler_valor_atalho(p_valor text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare t text := regexp_replace(coalesce(p_valor, ''), '[^0-9,.]', '', 'g');
begin
  if t = '' then return null; end if;
  if position(',' in t) > 0 then
    t := replace(replace(t, '.', ''), ',', '.');          -- 1.234,56 -> 1234.56
  elsif t ~ '^\d{1,3}(\.\d{3})+$' then
    t := replace(t, '.', '');                              -- 1.234 -> 1234
  end if;
  if t !~ '^\d+(\.\d{1,2})?$' then return null; end if;
  return round(t::numeric, 2);
end; $$;

-- Nomes das contas ativas do dono da chave (para o menu do atalho).
create function public.atalho_contas(p_chave text)
returns setof text language plpgsql stable security definer set search_path = '' as $$
declare v_usuario uuid := privado.dono_da_chave(p_chave);
begin
  if v_usuario is null then
    raise exception 'Chave inválida ou cancelada. Crie uma nova no app (Contas > Lançar pelo celular).' using errcode = '28000';
  end if;
  return query select c.nome from public.contas c where c.usuario_id = v_usuario and not c.arquivada order by c.nome;
end; $$;

-- Grava um lançamento. Devolve um texto curto para o celular mostrar.
create function public.atalho_lancar(p_chave text, p_valor text, p_descricao text default null,
                                     p_conta text default null, p_tipo text default 'despesa')
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash text := encode(sha256(convert_to(coalesce(btrim(p_chave), ''), 'UTF8')), 'hex');
  v_chave privado.chaves_atalho%rowtype;
  v_hoje date := (now() at time zone 'America/Belem')::date;
  v_tipo text := lower(btrim(coalesce(p_tipo, 'despesa')));
  v_valor numeric := privado.ler_valor_atalho(p_valor);
  v_desc text := left(regexp_replace(btrim(coalesce(p_descricao, '')), '\s+', ' ', 'g'), 120);
  v_conta uuid; v_conta_nome text; v_qtd_contas int;
  v_cat uuid; v_cat_nome text;
  v_primeira text;
begin
  select * into v_chave from privado.chaves_atalho k where k.chave_hash = v_hash and k.cancelada_em is null for update;
  if not found then
    raise exception 'Chave inválida ou cancelada. Crie uma nova no app (Contas > Lançar pelo celular).' using errcode = '28000';
  end if;
  if v_tipo in ('saida', 'saída', 'gasto') then v_tipo := 'despesa'; elsif v_tipo in ('entrada', 'recebido') then v_tipo := 'receita'; end if;
  if v_tipo not in ('despesa', 'receita') then
    raise exception 'Tipo inválido: use despesa ou receita.' using errcode = '22023';
  end if;
  if v_valor is null or v_valor <= 0 or v_valor > 99999999 then
    raise exception 'Valor inválido: %. Use algo como 12,50.', coalesce(p_valor, '(vazio)') using errcode = '22023';
  end if;
  if v_desc = '' then v_desc := case when v_tipo = 'despesa' then 'Gasto pelo atalho' else 'Entrada pelo atalho' end; end if;

  -- Limite diário por chave.
  if v_chave.uso_dia is distinct from v_hoje then v_chave.uso_qtd := 0; end if;
  if v_chave.uso_qtd >= 60 then
    raise exception 'Limite de 60 lançamentos por dia pelo atalho atingido. Lance pelo app.' using errcode = '54000';
  end if;

  -- Conta: pelo nome (sem diferença de maiúsculas); sem nome, só se a pessoa tiver uma conta ativa.
  if nullif(btrim(coalesce(p_conta, '')), '') is not null then
    select c.id, c.nome into v_conta, v_conta_nome from public.contas c
     where c.usuario_id = v_chave.usuario_id and not c.arquivada and lower(btrim(c.nome)) = lower(btrim(p_conta));
  else
    select count(*) into v_qtd_contas from public.contas c where c.usuario_id = v_chave.usuario_id and not c.arquivada;
    if v_qtd_contas = 1 then
      select c.id, c.nome into v_conta, v_conta_nome from public.contas c where c.usuario_id = v_chave.usuario_id and not c.arquivada;
    end if;
  end if;
  if v_conta is null then
    raise exception 'Conta "%" não encontrada. Suas contas: %.', coalesce(p_conta, ''),
      (select string_agg(c.nome, ', ' order by c.nome) from public.contas c where c.usuario_id = v_chave.usuario_id and not c.arquivada)
      using errcode = '22023';
  end if;

  -- Toque repetido (mesmo valor, conta e descrição em 2 minutos): não grava de novo.
  if exists (select 1 from public.lancamentos l
              where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.tipo = v_tipo
                and l.valor = v_valor and l.descricao = v_desc and l.criado_em > now() - interval '2 minutes') then
    return format('Já estava lançado: R$ %s em %s.', translate(to_char(v_valor, 'FM99,999,990.00'), ',.', '.,'), v_conta_nome);
  end if;

  -- Categoria: a mesma do último lançamento com a mesma descrição; senão, com a mesma primeira palavra;
  -- senão, "Outras despesas" / "Outras receitas". Só categorias ativas e do mesmo tipo.
  select l.categoria_id into v_cat from public.lancamentos l join public.categorias c on c.id = l.categoria_id
   where l.usuario_id = v_chave.usuario_id and l.tipo = v_tipo and not c.arquivada and lower(l.descricao) = lower(v_desc)
   order by l.data desc, l.criado_em desc limit 1;
  v_primeira := lower(substring(v_desc from '^[^\s\-–,.:/]+'));
  if v_cat is null and char_length(coalesce(v_primeira, '')) >= 3 then
    select l.categoria_id into v_cat from public.lancamentos l join public.categorias c on c.id = l.categoria_id
     where l.usuario_id = v_chave.usuario_id and l.tipo = v_tipo and not c.arquivada
       and lower(substring(l.descricao from '^[^\s\-–,.:/]+')) = v_primeira
     order by l.data desc, l.criado_em desc limit 1;
  end if;
  if v_cat is null then
    select c.id into v_cat from public.categorias c
     where c.usuario_id = v_chave.usuario_id and c.tipo = v_tipo and not c.arquivada
       and lower(c.nome) = case when v_tipo = 'despesa' then 'outras despesas' else 'outras receitas' end
     limit 1;
  end if;
  select c.nome into v_cat_nome from public.categorias c where c.id = v_cat;

  insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, categoria_id, pago, observacoes)
  values (v_chave.usuario_id, v_tipo, v_desc, v_valor, v_hoje, v_conta, v_cat, true, 'Lançado pelo atalho do celular.');

  update privado.chaves_atalho k set ultimo_uso = now(), uso_dia = v_hoje, uso_qtd = v_chave.uso_qtd + 1 where k.id = v_chave.id;

  return format('%s: R$ %s em %s (%s).', case when v_tipo = 'despesa' then 'Gasto lançado' else 'Entrada lançada' end,
    translate(to_char(v_valor, 'FM99,999,990.00'), ',.', '.,'), v_conta_nome, coalesce(v_cat_nome, 'sem categoria'));
end; $$;

revoke all on function privado.dono_da_chave(text), privado.ler_valor_atalho(text) from public, anon, authenticated;
revoke all on function public.criar_chave_atalho(text), public.listar_chaves_atalho(), public.cancelar_chave_atalho(uuid),
  public.atalho_contas(text), public.atalho_lancar(text, text, text, text, text) from public;
-- O Supabase dá EXECUTE automático a anon/authenticated em funções novas do esquema public: tira de quem não deve ter.
revoke all on function public.criar_chave_atalho(text), public.listar_chaves_atalho(), public.cancelar_chave_atalho(uuid) from anon;
grant execute on function public.criar_chave_atalho(text), public.listar_chaves_atalho(), public.cancelar_chave_atalho(uuid) to authenticated;
grant execute on function public.atalho_contas(text), public.atalho_lancar(text, text, text, text, text) to anon, authenticated;
