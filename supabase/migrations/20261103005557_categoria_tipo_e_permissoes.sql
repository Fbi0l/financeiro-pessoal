-- Reforço de integridade e limpeza de permissões (versão 0.2.2).

-- 1) Permissões que o app não usa.
--    TRUNCATE ignora as regras de acesso (RLS); TRIGGER e REFERENCES não têm uso pelo app.
--    A visão de saldos é só para leitura.
revoke truncate, trigger, references on public.contas, public.categorias, public.lancamentos from authenticated;
revoke insert, update, delete, truncate, trigger, references on public.saldos_contas from authenticated;
revoke execute on function privado.tocar_atualizado_em() from public;

-- 2) A categoria precisa combinar com o tipo do lançamento
--    (saída só com categoria de saída; entrada só com categoria de entrada).
--    Importante antes da importação de extratos, que grava muitos lançamentos de uma vez.
create or replace function privado.conferir_categoria_lancamento()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare tipo_cat text;
begin
  if new.categoria_id is null then return new; end if;
  select c.tipo into tipo_cat from public.categorias c where c.id = new.categoria_id;
  if tipo_cat is distinct from new.tipo then
    raise exception 'A categoria escolhida é de %, mas o lançamento é de %.',
      coalesce(tipo_cat, 'outro tipo'), new.tipo
      using errcode = '23514', hint = 'categoria_tipo';
  end if;
  return new;
end; $$;
revoke execute on function privado.conferir_categoria_lancamento() from public, anon, authenticated;

create trigger lancamentos_categoria_tipo
  before insert or update of tipo, categoria_id on public.lancamentos
  for each row execute function privado.conferir_categoria_lancamento();
