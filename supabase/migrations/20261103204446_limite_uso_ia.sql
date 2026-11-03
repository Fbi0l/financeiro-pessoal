-- Limite diário de uso do assistente (versão 0.9.0): cada pessoa tem a própria cota,
-- para que ninguém esgote sozinho a cota gratuita do serviço de IA, que é de todos.
-- O contador fica no esquema privado (fora da API); só a função abaixo mexe nele.

create table privado.uso_ia (
  usuario_id uuid not null references auth.users(id) on delete cascade,
  dia date not null,
  chamadas integer not null default 0 check (chamadas >= 0),
  primary key (usuario_id, dia)
);

-- Soma 1 ao uso de hoje (dia de Belém) de quem chamou e devolve o total do dia.
-- Não recebe parâmetros: cada pessoa só consegue contar o próprio uso.
-- A função "agente" decide o limite; chamar esta função direto só gasta a cota de quem chamou.
create function public.consumir_uso_ia()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usuario uuid := (select auth.uid());
  v_dia date := (now() at time zone 'America/Belem')::date;
  v_total integer;
begin
  if v_usuario is null then
    raise exception 'Entre no app para usar o assistente.' using errcode = '42501';
  end if;
  insert into privado.uso_ia as u (usuario_id, dia, chamadas)
  values (v_usuario, v_dia, 1)
  on conflict (usuario_id, dia) do update set chamadas = u.chamadas + 1
  returning u.chamadas into v_total;
  -- Guarda só os últimos 30 dias.
  delete from privado.uso_ia where usuario_id = v_usuario and dia < v_dia - 30;
  return v_total;
end;
$$;

revoke all on function public.consumir_uso_ia() from public, anon;
grant execute on function public.consumir_uso_ia() to authenticated;
