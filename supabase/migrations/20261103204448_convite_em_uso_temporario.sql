-- Convite "Em uso agora" só por alguns minutos (versão 0.9.0).
-- O cadastro marca o convite antes de criar a conta e grava quem usou no fim. Se essa última
-- gravação falhar, o convite ficava "Em uso agora" para sempre. Depois de 10 minutos ele passa
-- a aparecer como usado (o link já não funciona de qualquer forma).
create or replace function public.listar_convites()
returns table(id uuid, rotulo text, criado_em timestamptz, expira_em timestamptz, usado_em timestamptz, situacao text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.sou_administrador() then
    raise exception 'Somente o administrador pode ver os convites.' using errcode = '42501';
  end if;
  return query
    select c.id, c.rotulo, c.criado_em, c.expira_em, c.usado_em,
      case when c.usado_em is not null and c.usado_por is not null then 'usado'
           when c.cancelado_em is not null then 'cancelado'
           when c.usado_em is not null and c.usado_em > now() - interval '10 minutes' then 'em_uso'
           when c.usado_em is not null then 'usado'
           when c.expira_em <= now() then 'vencido'
           else 'pendente' end
    from public.convites c
    where c.criado_por = (select auth.uid())
    order by c.criado_em desc
    limit 50;
end;
$$;
