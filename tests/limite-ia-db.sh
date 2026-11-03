#!/usr/bin/env bash
# Limite de uso do assistente no banco (PostgreSQL de teste, sem tocar no Supabase real):
# cada pessoa conta só o próprio uso, o contador fica fora da API e anônimos não usam a função.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }
q -c "drop database if exists fin_limite_ia" -c "create database fin_limite_ia"
q -d fin_limite_ia -f "$raiz/tests/supabase-simulado.sql"
for m in "$raiz"/supabase/migrations/*.sql; do q -d fin_limite_ia -f "$m"; done
U1=00000000-0000-0000-0000-0000000000a1; U2=00000000-0000-0000-0000-0000000000b2
q -d fin_limite_ia -c "insert into auth.users (id, email) values ('$U1','a@exemplo.com'), ('$U2','b@exemplo.com')"
como() { { q -d fin_limite_ia -c "begin; set local role $1; select set_config('request.jwt.claim.sub', '$2', true); $3; commit;" 2>&1 || true; } | { grep -v "^CONTEXT\|^PL/pgSQL\|^LINE\|^ *\^\|^$" || true; } | tail -1; }
falha=0; ok() { echo "ok  $1"; }; erro() { echo "ERRO $1: $2"; falha=1; }

como authenticated "$U1" "select public.consumir_uso_ia()" >/dev/null
r=$(como authenticated "$U1" "select public.consumir_uso_ia()")
[[ "$r" == 2 ]] && ok "conta o uso do dia" || erro "contagem" "$r"
r=$(como authenticated "$U2" "select public.consumir_uso_ia()")
[[ "$r" == 1 ]] && ok "cada pessoa tem a propria cota" || erro "cota separada" "$r"
r=$(como authenticated "$U1" "select count(*) from privado.uso_ia")
[[ "$r" == *"permission denied"* ]] && ok "contador fora da API" || erro "contador exposto" "$r"
r=$(como anon "" "select public.consumir_uso_ia()")
[[ "$r" == *"permission denied"* ]] && ok "anonimo nao usa" || erro "anonimo" "$r"
r=$(como authenticated "" "select public.consumir_uso_ia()")
[[ "$r" == *"Entre no app"* ]] && ok "sem login recusa" || erro "sem login" "$r"
# Dias antigos sao apagados ao contar.
q -d fin_limite_ia -c "insert into privado.uso_ia values ('$U1', current_date - 40, 5)"
como authenticated "$U1" "select public.consumir_uso_ia()" >/dev/null
r=$(q -d fin_limite_ia -c "select count(*) from privado.uso_ia where usuario_id = '$U1'")
[[ "$r" == 1 ]] && ok "guarda so os ultimos 30 dias" || erro "limpeza" "$r"
q -c "drop database fin_limite_ia"
exit $falha
