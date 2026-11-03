-- Importação de extrato (versão 0.3.0).
-- origem: de onde veio o lançamento ('manual' ou 'importacao').
-- id_externo: identificador do movimento no extrato (o do banco, ou data+valor+descrição).
-- A regra única impede importar o mesmo movimento duas vezes na mesma conta.
-- Lançamentos manuais ficam com id_externo vazio (NULL) e não entram nessa regra.
alter table public.lancamentos
  add column origem text not null default 'manual' check (origem in ('manual', 'importacao')),
  add column id_externo text check (id_externo is null or char_length(id_externo) between 1 and 200);

alter table public.lancamentos
  add constraint lancamentos_id_externo_unico unique (usuario_id, conta_id, id_externo);

-- Coerência: lançamento importado sempre tem identificador; manual nunca tem.
alter table public.lancamentos
  add constraint lancamentos_origem_consistente check ((origem = 'importacao') = (id_externo is not null));
