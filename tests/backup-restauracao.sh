#!/usr/bin/env bash
# Ensaio completo do backup, sem tocar no Supabase real:
# cria um banco local com as MIGRAÇÕES REAIS do projeto e dados fictícios, roda scripts/backup.sh,
# descriptografa, restaura num banco vazio e confere se tudo voltou igual (dados, regras e gatilhos).
# Requer: PostgreSQL acessível em PGHOST/PGPORT com um superusuário (PGUSER/PGPASSWORD), age e age-keygen.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }

for db in fin_origem fin_destino; do q -c "drop database if exists $db" -c "create database $db"; done

# Simula o que o Supabase já fornece: papéis, esquema auth e auth.uid().
simular_supabase() { q -d "$1" -f "$raiz/tests/supabase-simulado.sql"; }
simular_supabase fin_origem
for m in "$raiz"/supabase/migrations/*.sql; do q -d fin_origem -f "$m"; done

# Dados fictícios (o gatilho cria as contas e categorias padrão do usuário).
q -d fin_origem <<'SQL'
insert into auth.users values ('00000000-0000-0000-0000-000000000001', 'teste@exemplo.com');
insert into auth.identities values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001');
insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, categoria_id, conta_destino_id, pago)
select u, t.tipo, t.descricao, t.valor, t.data::date,
  (select id from public.contas where nome = t.conta),
  (select id from public.categorias where nome = t.cat),
  (select id from public.contas where nome = t.destino), t.pago
from (values
  ('despesa','Mercado',1234.56,'2026-11-02','Nubank','Supermercado',null,true),
  ('receita','Salário',3000.00,'2026-11-05','Itaú','Salário',null,false),
  ('transferencia','Guardar',200.00,'2026-11-03','Nubank',null,'Espécie',true)
) as t(tipo, descricao, valor, data, conta, cat, destino, pago),
lateral (select '00000000-0000-0000-0000-000000000001'::uuid as u) x;
SQL

# Chave de teste descartável.
age-keygen -o "$tmp/chave.txt" 2>/dev/null
publica="$(age-keygen -y "$tmp/chave.txt")"

for escopo in dados auth; do
  BACKUP_SCOPE=$escopo PG_CLIENT=local PGDATABASE=fin_origem BACKUP_AGE_RECIPIENT="$publica" BACKUP_OUTPUT_DIR="$tmp/saida" \
    bash "$raiz/scripts/backup.sh" >/dev/null
done
ls "$tmp/saida" | grep -q '\.dump$' && { echo "FALHA: sobrou arquivo sem criptografia"; exit 1; }
( cd "$tmp/saida" && sha256sum -c --quiet ./*.sha256 )

# Restauração num banco vazio: primeiro as contas de login, depois os dados.
simular_supabase fin_destino
for escopo in auth dados; do
  arq="$(ls "$tmp"/saida/financeiro_${escopo}_*.dump.age)"
  age --decrypt -i "$tmp/chave.txt" -o "$tmp/$escopo.dump" "$arq"
done
pg_restore --no-owner --no-acl -d fin_destino "$tmp/auth.dump"
# O esquema public ja existe em qualquer banco novo (inclusive no Supabase): pula so esse item.
pg_restore -l "$tmp/dados.dump" | grep -vE ' SCHEMA - public ' > "$tmp/lista.txt"
pg_restore --no-owner --exit-on-error -L "$tmp/lista.txt" -d fin_destino "$tmp/dados.dump"

conferir() { q -d "$1" -c "select
  (select count(*) from public.contas)||'/'||(select count(*) from public.categorias)||'/'||(select count(*) from public.lancamentos)||'|'||
  (select string_agg(nome||'='||saldo_atual, ',' order by nome) from public.saldos_contas)||'|'||
  (select count(*) from auth.users)||'|'||
  (select count(*) from pg_policies where schemaname='public')||'|'||
  (select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid='public.lancamentos'::regclass and not tgisinternal)||'|'||
  (select string_agg(grantee||':'||table_name||':'||privilege_type, ',' order by grantee, table_name, privilege_type) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public')||'|'||
  has_function_privilege('authenticated','public.resumo_periodo(date,date)','execute')||'/'||has_function_privilege('anon','public.resumo_periodo(date,date)','execute')||'/'||has_schema_privilege('authenticated','privado','usage')"; }
antes="$(conferir fin_origem)"; depois="$(conferir fin_destino)"
echo "Origem:  $antes"; echo "Destino: $depois"
[[ "$antes" == "$depois" ]] || { echo "FALHA: o banco restaurado ficou diferente"; exit 1; }

# As regras continuam valendo depois da restauração (a trava de categoria, se a migração já existir).
if [[ "$depois" == *lancamentos_categoria_tipo* ]] && q -d fin_destino -c "insert into public.lancamentos (usuario_id,tipo,descricao,valor,conta_id,categoria_id) select '00000000-0000-0000-0000-000000000001','despesa','x',10,(select id from public.contas where nome='Nubank'),(select id from public.categorias where nome='Salário')" 2>/dev/null; then
  echo "FALHA: trava de categoria nao veio na restauracao"; exit 1
fi
for db in fin_origem fin_destino; do q -c "drop database $db"; done
echo "Backup aprovado: criptografado, checksum conferido, restaurado igual a origem e com as regras ativas."
