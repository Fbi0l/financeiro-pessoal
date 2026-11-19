-- Lançamentos automáticos a partir dos e-mails do banco (reembolsos, transferências, Pix).
-- Uma tarefa agendada lê os e-mails e chama public.automacao_lancar com uma chave do atalho
-- (a mesma tabela privado.chaves_atalho: o dono vê e cancela em Contas > Lançar pelo celular).
--
-- Diferenças em relação a atalho_lancar:
-- - aceita transferência entre contas (p_conta_destino) e a data do movimento (até 60 dias para trás);
-- - p_id_externo (ex.: 'email:<id da mensagem>') é obrigatório: o mesmo e-mail nunca é lançado duas vezes;
-- - se já existe um lançamento igual (mesma conta, tipo, valor e data com 1 dia de folga, e mesmo destino
--   na transferência), por exemplo lançado à mão ou pelo Gastei, não grava de novo.

-- Categoria aprendida: a do último lançamento com a mesma descrição; senão, com a mesma primeira palavra;
-- senão "Outras despesas" / "Outras receitas". Só categorias ativas e do mesmo tipo.
create function privado.categoria_aprendida(p_usuario uuid, p_tipo text, p_descricao text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_cat uuid; v_primeira text := lower(substring(p_descricao from '^[^\s\-–,.:/]+'));
begin
  select l.categoria_id into v_cat from public.lancamentos l join public.categorias c on c.id = l.categoria_id
   where l.usuario_id = p_usuario and l.tipo = p_tipo and not c.arquivada and lower(l.descricao) = lower(p_descricao)
   order by l.data desc, l.criado_em desc limit 1;
  if v_cat is null and char_length(coalesce(v_primeira, '')) >= 3 then
    select l.categoria_id into v_cat from public.lancamentos l join public.categorias c on c.id = l.categoria_id
     where l.usuario_id = p_usuario and l.tipo = p_tipo and not c.arquivada
       and lower(substring(l.descricao from '^[^\s\-–,.:/]+')) = v_primeira
     order by l.data desc, l.criado_em desc limit 1;
  end if;
  if v_cat is null then
    select c.id into v_cat from public.categorias c
     where c.usuario_id = p_usuario and c.tipo = p_tipo and not c.arquivada
       and lower(c.nome) = case when p_tipo = 'despesa' then 'outras despesas' else 'outras receitas' end
     limit 1;
  end if;
  return v_cat;
end; $$;

create function public.automacao_lancar(p_chave text, p_tipo text, p_valor text, p_descricao text,
                                        p_conta text, p_data date, p_id_externo text, p_conta_destino text default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hash text := encode(sha256(convert_to(coalesce(btrim(p_chave), ''), 'UTF8')), 'hex');
  v_chave privado.chaves_atalho%rowtype;
  v_hoje date := (now() at time zone 'America/Belem')::date;
  v_tipo text := lower(btrim(coalesce(p_tipo, '')));
  v_valor numeric := privado.ler_valor_atalho(p_valor);
  v_desc text := left(regexp_replace(btrim(coalesce(p_descricao, '')), '\s+', ' ', 'g'), 120);
  v_id text := btrim(coalesce(p_id_externo, ''));
  v_conta uuid; v_conta_nome text; v_dest uuid; v_dest_nome text; v_cat uuid; v_cat_nome text;
  v_valor_txt text;
begin
  select * into v_chave from privado.chaves_atalho k where k.chave_hash = v_hash and k.cancelada_em is null for update;
  if not found then
    raise exception 'Chave inválida ou cancelada.' using errcode = '28000';
  end if;
  if v_tipo not in ('despesa', 'receita', 'transferencia') then
    raise exception 'Tipo inválido: use despesa, receita ou transferencia.' using errcode = '22023';
  end if;
  if v_valor is null or v_valor <= 0 or v_valor > 99999999 then
    raise exception 'Valor inválido: %.', coalesce(p_valor, '(vazio)') using errcode = '22023';
  end if;
  if p_data is null or p_data > v_hoje or p_data < v_hoje - 60 then
    raise exception 'Data inválida: %. Use uma data dos últimos 60 dias.', coalesce(p_data::text, '(vazia)') using errcode = '22023';
  end if;
  if char_length(v_id) not between 3 and 200 then
    raise exception 'Informe o código do movimento (p_id_externo).' using errcode = '22023';
  end if;
  if v_desc = '' then v_desc := case v_tipo when 'despesa' then 'Gasto' when 'receita' then 'Entrada' else 'Transferência' end; end if;
  v_valor_txt := translate(to_char(v_valor, 'FM99,999,990.00'), ',.', '.,');

  if v_chave.uso_dia is distinct from v_hoje then v_chave.uso_qtd := 0; end if;
  if v_chave.uso_qtd >= 60 then
    raise exception 'Limite de 60 lançamentos por dia atingido.' using errcode = '54000';
  end if;

  select c.id, c.nome into v_conta, v_conta_nome from public.contas c
   where c.usuario_id = v_chave.usuario_id and not c.arquivada and lower(btrim(c.nome)) = lower(btrim(coalesce(p_conta, '')));
  if v_conta is null then
    raise exception 'Conta "%" não encontrada.', coalesce(p_conta, '') using errcode = '22023';
  end if;
  if v_tipo = 'transferencia' then
    select c.id, c.nome into v_dest, v_dest_nome from public.contas c
     where c.usuario_id = v_chave.usuario_id and not c.arquivada and lower(btrim(c.nome)) = lower(btrim(coalesce(p_conta_destino, '')));
    if v_dest is null or v_dest = v_conta then
      raise exception 'Conta de destino "%" não encontrada ou igual à de origem.', coalesce(p_conta_destino, '') using errcode = '22023';
    end if;
  end if;

  -- Mesmo e-mail de novo: nada a fazer.
  if exists (select 1 from public.lancamentos l where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.id_externo = v_id) then
    return format('Já registrado: R$ %s em %s.', v_valor_txt, v_conta_nome);
  end if;
  -- Já lançado de outro jeito (à mão, pelo Gastei, pelo extrato): não duplica.
  if exists (select 1 from public.lancamentos l
              where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.tipo = v_tipo and l.valor = v_valor
                and l.data between p_data - 1 and p_data + 1
                and l.conta_destino_id is not distinct from v_dest) then
    return format('Já existia: R$ %s em %s (%s). Nada gravado.', v_valor_txt, v_conta_nome, to_char(p_data, 'DD/MM'));
  end if;

  if v_tipo <> 'transferencia' then
    v_cat := privado.categoria_aprendida(v_chave.usuario_id, v_tipo, v_desc);
    select c.nome into v_cat_nome from public.categorias c where c.id = v_cat;
  end if;

  insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, conta_destino_id, categoria_id,
                                  pago, origem, id_externo, observacoes)
  values (v_chave.usuario_id, v_tipo, v_desc, v_valor, p_data, v_conta, v_dest, v_cat,
          true, 'importacao', v_id, 'Lançado automaticamente pelo e-mail do banco.');

  update privado.chaves_atalho k set ultimo_uso = now(), uso_dia = v_hoje, uso_qtd = v_chave.uso_qtd + 1 where k.id = v_chave.id;

  return case v_tipo
    when 'transferencia' then format('Transferência lançada: R$ %s de %s para %s (%s).', v_valor_txt, v_conta_nome, v_dest_nome, to_char(p_data, 'DD/MM'))
    else format('%s: R$ %s em %s (%s, %s).', case when v_tipo = 'despesa' then 'Gasto lançado' else 'Entrada lançada' end,
                v_valor_txt, v_conta_nome, coalesce(v_cat_nome, 'sem categoria'), to_char(p_data, 'DD/MM'))
  end;
end; $$;

revoke all on function privado.categoria_aprendida(uuid, text, text) from public, anon, authenticated;
revoke all on function public.automacao_lancar(text, text, text, text, text, date, text, text) from public;
grant execute on function public.automacao_lancar(text, text, text, text, text, date, text, text) to anon, authenticated;
