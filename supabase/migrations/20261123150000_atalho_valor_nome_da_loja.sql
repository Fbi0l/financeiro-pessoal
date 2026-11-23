-- Atalho do celular: quando o valor chega sem número e com letras (na automação da Carteira,
-- o campo p_valor ficou com o nome da loja), a mensagem de erro explica como corrigir no iPhone.
-- Só muda a mensagem; o resto de atalho_lancar fica igual. As permissões continuam as mesmas.
-- ATENÇÃO: renomeie o arquivo com a versão que o Supabase registrar ao aplicar.

create or replace function public.atalho_lancar(p_chave text, p_valor text, p_descricao text default null,
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
    -- Na automação da Carteira, o erro mais comum é o campo do valor ficar com a variável inteira
    -- (que vira o nome da loja) em vez da propriedade "Valor". Explica como corrigir.
    if coalesce(p_valor, '') ~ '[[:alpha:]]{2,}' and coalesce(p_valor, '') !~ '[0-9]' then
      raise exception 'O valor chegou como "%", que parece o nome da loja. No app Atalhos, abra a automação, toque na variável do campo p_valor e escolha "Valor".',
        left(btrim(p_valor), 60) using errcode = '22023';
    end if;
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
