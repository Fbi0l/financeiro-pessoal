-- Importação automática do extrato que chega por e-mail (tarefa agendada) + conferência de saldo.
--
-- automacao_lancar passa a entender linhas de EXTRATO (código 'b:…' ou 'h:…', o mesmo que o importador do app usa):
-- - cada linha do extrato "assume" no máximo um lançamento igual ainda não conferido com o banco
--   (feito à mão, pelo Gastei ou vindo de e-mail): ele ganha o código do banco e vira importado.
--   Assim dois gastos iguais no mesmo dia, um lançado e outro esquecido, resultam em exatamente dois.
-- - linhas de e-mail ('email:…') continuam como antes: se já existe igual, não grava (e não assumem nada).
-- - limite diário da automação: 300 lançamentos novos por chave (um extrato de mês inteiro cabe).
-- automacao_saldo devolve o saldo de uma conta no fim de um dia, para comparar com o saldo do extrato.
-- Com a chave dá para ver esse número de saldo; nada mais é lido.

create or replace function public.automacao_lancar(p_chave text, p_tipo text, p_valor text, p_descricao text,
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
  v_extrato boolean;
  v_conta uuid; v_conta_nome text; v_dest uuid; v_dest_nome text; v_cat uuid; v_cat_nome text;
  v_valor_txt text; v_par uuid; v_par_data date;
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
  v_extrato := v_id ~ '^(b|h):';
  if v_desc = '' then v_desc := case v_tipo when 'despesa' then 'Gasto' when 'receita' then 'Entrada' else 'Transferência' end; end if;
  v_valor_txt := translate(to_char(v_valor, 'FM99,999,990.00'), ',.', '.,');

  if v_chave.uso_dia is distinct from v_hoje then v_chave.uso_qtd := 0; end if;

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

  -- Mesmo movimento de novo (mesmo e-mail ou mesma linha de extrato): nada a fazer.
  if exists (select 1 from public.lancamentos l where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.id_externo = v_id) then
    return format('Já registrado: R$ %s em %s.', v_valor_txt, v_conta_nome);
  end if;

  if v_extrato then
    -- Linha do extrato: assume UM lançamento igual ainda não conferido com o banco (o de data mais próxima).
    select l.id, l.data into v_par, v_par_data from public.lancamentos l
     where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.tipo = v_tipo and l.valor = v_valor
       and l.data between p_data - 1 and p_data + 1
       and l.conta_destino_id is not distinct from v_dest
       and (l.id_externo is null or l.id_externo like 'email:%')
     order by abs(l.data - p_data), l.criado_em
     limit 1 for update;
    if v_par is not null then
      update public.lancamentos l set id_externo = v_id, origem = 'importacao',
             data = p_data  -- vale a data do banco
       where l.id = v_par;
      return format('Conferido com o banco: R$ %s em %s (%s)%s.', v_valor_txt, v_conta_nome, to_char(p_data, 'DD/MM'),
                    case when v_par_data <> p_data then ', data corrigida de ' || to_char(v_par_data, 'DD/MM') else '' end);
    end if;
  else
    -- E-mail: se já existe igual (de qualquer origem), não grava.
    if exists (select 1 from public.lancamentos l
                where l.usuario_id = v_chave.usuario_id and l.conta_id = v_conta and l.tipo = v_tipo and l.valor = v_valor
                  and l.data between p_data - 1 and p_data + 1
                  and l.conta_destino_id is not distinct from v_dest) then
      return format('Já existia: R$ %s em %s (%s). Nada gravado.', v_valor_txt, v_conta_nome, to_char(p_data, 'DD/MM'));
    end if;
  end if;

  if v_chave.uso_qtd >= 300 then
    raise exception 'Limite de 300 lançamentos novos por dia atingido.' using errcode = '54000';
  end if;

  if v_tipo <> 'transferencia' then
    v_cat := privado.categoria_aprendida(v_chave.usuario_id, v_tipo, v_desc);
    select c.nome into v_cat_nome from public.categorias c where c.id = v_cat;
  end if;

  insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, conta_destino_id, categoria_id,
                                  pago, origem, id_externo, observacoes)
  values (v_chave.usuario_id, v_tipo, v_desc, v_valor, p_data, v_conta, v_dest, v_cat,
          true, 'importacao', v_id,
          case when v_extrato then 'Lançado automaticamente pelo extrato do banco.' else 'Lançado automaticamente pelo e-mail do banco.' end);

  update privado.chaves_atalho k set ultimo_uso = now(), uso_dia = v_hoje, uso_qtd = v_chave.uso_qtd + 1 where k.id = v_chave.id;

  return case v_tipo
    when 'transferencia' then format('Transferência lançada: R$ %s de %s para %s (%s).', v_valor_txt, v_conta_nome, v_dest_nome, to_char(p_data, 'DD/MM'))
    else format('%s: R$ %s em %s (%s, %s).', case when v_tipo = 'despesa' then 'Gasto lançado' else 'Entrada lançada' end,
                v_valor_txt, v_conta_nome, coalesce(v_cat_nome, 'sem categoria'), to_char(p_data, 'DD/MM'))
  end;
end; $$;

-- Saldo de uma conta no fim de um dia (só lançamentos pagos), para comparar com o saldo final do extrato.
create function public.automacao_saldo(p_chave text, p_conta text, p_data date)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v_usuario uuid := privado.dono_da_chave(p_chave); v_conta uuid; v_inicial numeric;
begin
  if v_usuario is null then
    raise exception 'Chave inválida ou cancelada.' using errcode = '28000';
  end if;
  select c.id, c.saldo_inicial into v_conta, v_inicial from public.contas c
   where c.usuario_id = v_usuario and lower(btrim(c.nome)) = lower(btrim(coalesce(p_conta, '')));
  if v_conta is null then
    raise exception 'Conta "%" não encontrada.', coalesce(p_conta, '') using errcode = '22023';
  end if;
  return v_inicial + coalesce((
    select sum(case
                 when l.conta_destino_id = v_conta then l.valor
                 when l.tipo = 'receita' then l.valor
                 else -l.valor end)
    from public.lancamentos l
    where l.usuario_id = v_usuario and l.pago and l.data <= p_data
      and (l.conta_id = v_conta or l.conta_destino_id = v_conta)), 0);
end; $$;

revoke all on function public.automacao_saldo(text, text, date) from public;
grant execute on function public.automacao_saldo(text, text, date) to anon, authenticated;
