#!/usr/bin/env bash
# Histórico de importações no banco (PostgreSQL de teste, sem tocar no Supabase real):
# apagar uma importação apaga só os lançamentos dela; manuais e de outras importações ficam;
# um usuário não vê, não apaga e não usa a importação de outro.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }
q -c "drop database if exists fin_importacoes" -c "create database fin_importacoes"
q -d fin_importacoes -f "$raiz/tests/supabase-simulado.sql"
# Todas as migracoes menos a do historico; depois, dados "antigos" (importados antes dela); por fim, ela.
migracoes=("$raiz"/supabase/migrations/*.sql ${IMPORTACOES_SQL:-})
ultima="${migracoes[-1]}"; [[ "$ultima" == *historico_importacoes* ]] || { echo "migracao do historico deveria ser a ultima"; exit 1; }
for m in "${migracoes[@]:0:${#migracoes[@]}-1}"; do [[ "$m" == *historico_importacoes* ]] || q -d fin_importacoes -f "$m"; done
# Usuarios criados depois das migracoes: o gatilho cria as contas e categorias padrao.
q -d fin_importacoes -c "insert into auth.users (id, email, created_at) values
  ('00000000-0000-0000-0000-0000000000a1','titular@exemplo.com', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000b2','outra@exemplo.com', now())"
q -d fin_importacoes -c "insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, pago, origem, id_externo, criado_em)
  select u, 'despesa', 'antigo', v, d::date, (select id from public.contas where usuario_id = u and nome = 'Nubank'), true, 'importacao', e, c::timestamptz
  from (values ('00000000-0000-0000-0000-0000000000a1'::uuid, 1, '2026-10-05', 'b:o1', '2026-11-03 03:55:38.10+00'),
               ('00000000-0000-0000-0000-0000000000a1'::uuid, 2, '2026-10-27', 'b:o2', '2026-11-03 03:55:38.10+00'),
               ('00000000-0000-0000-0000-0000000000a1'::uuid, 3, '2026-09-01', 'b:s1', '2026-11-03 03:58:02.50+00')) x(u, v, d, e, c)"
q -d fin_importacoes -f "$ultima"

como() { # papel, usuario, sql
  q -d fin_importacoes -c "begin; set local role $1; select set_config('request.jwt.claim.sub', '$2', true); $3; commit;" 2>&1 | { grep -v "^CONTEXT\|^PL/pgSQL\|^$" || true; } | tail -1; }
U1=00000000-0000-0000-0000-0000000000a1; U2=00000000-0000-0000-0000-0000000000b2
falha=0; ok() { echo "ok  $1"; }; erro() { echo "ERRO $1: $2"; falha=1; }
conta() { q -d fin_importacoes -c "select id from public.contas where usuario_id = '$1' and nome = '$2'"; }
cat_desp() { q -d fin_importacoes -c "select id from public.categorias where usuario_id = '$1' and tipo = 'despesa' limit 1"; }
C1="$(conta $U1 Itaú)"; C1b="$(conta $U1 Nubank)"; C2="$(conta $U2 Itaú)"; K1="$(cat_desp $U1)"

# Importacoes antigas ganharam registro (uma por minuto de gravacao) e podem ser apagadas.
[[ "$(q -d fin_importacoes -c "select string_agg(arquivo || ':' || periodo_inicio || '>' || periodo_fim || ':' || (select count(*) from public.lancamentos l where l.importacao_id = i.id), ',' order by criado_em) from public.importacoes i")" == "Importação anterior:2026-10-05>2026-10-27:2,Importação anterior:2026-09-01>2026-09-01:1" ]] && ok "importacoes antigas viraram 2 registros com os lancamentos certos" || erro "importacoes antigas" "$(q -d fin_importacoes -c "select arquivo, periodo_inicio, periodo_fim from public.importacoes")"
[[ "$(q -d fin_importacoes -c "select count(*) from public.lancamentos where origem = 'importacao' and importacao_id is null")" == "0" ]] && ok "nenhum lancamento importado ficou sem registro" || erro "sobrou sem registro" ""
como authenticated $U1 "delete from public.importacoes" >/dev/null
[[ "$(q -d fin_importacoes -c "select count(*) from public.lancamentos")" == "0" ]] && ok "importacoes antigas podem ser apagadas" || erro "apagar antigas" ""

nova_importacao() { # usuario, conta, arquivo
  como authenticated "$1" "insert into public.importacoes (conta_id, arquivo, formato, periodo_inicio, periodo_fim) values ('$2', '$3', 'OFX', '2026-10-01', '2026-10-31') returning id" | grep -oE '^[0-9a-f-]{36}$' || true; }
I1="$(nova_importacao $U1 "$C1" outubro.ofx)"; I1b="$(nova_importacao $U1 "$C1" repetido.ofx)"; I2="$(nova_importacao $U2 "$C2" dela.ofx)"
[[ -n "$I1" && -n "$I1b" && -n "$I2" ]] && ok "cada usuario registra as proprias importacoes" || erro "criar importacao" "$I1 $I1b $I2"

lanc() { # usuario, conta, importacao (ou vazio = manual), id_externo, valor
  local imp="null" origem="'manual'" ext="null"
  [[ -n "$3" ]] && { imp="'$3'"; origem="'importacao'"; ext="'$4'"; }
  como authenticated "$1" "insert into public.lancamentos (tipo, descricao, valor, data, conta_id, pago, origem, id_externo, importacao_id) values ('despesa', 'teste', $5, '2026-10-10', '$2', true, $origem, $ext, $imp)"; }
lanc $U1 "$C1" "$I1" a 10 >/dev/null; lanc $U1 "$C1" "$I1" b 20 >/dev/null; lanc $U1 "$C1" "$I1" c 30 >/dev/null
lanc $U1 "$C1" "$I1b" d 40 >/dev/null; lanc $U1 "$C1" "" "" 50 >/dev/null
lanc $U2 "$C2" "$I2" a 60 >/dev/null
[[ "$(como authenticated $U1 "select quantidade || '|' || saidas from public.importacoes_resumo where id = '$I1'")" == "3|60.00" ]] && ok "resumo conta os lancamentos e soma as saidas" || erro "resumo" "$(como authenticated $U1 "select * from public.importacoes_resumo where id = '$I1'")"

# Isolamento entre usuarios.
[[ "$(como authenticated $U2 "select count(*) from public.importacoes_resumo")" == "1" ]] && ok "outro usuario so ve a propria importacao" || erro "ver alheia" ""
como authenticated $U2 "delete from public.importacoes where id = '$I1'" >/dev/null
[[ "$(q -d fin_importacoes -c "select count(*) from public.lancamentos where importacao_id = '$I1'")" == "3" ]] && ok "outro usuario nao apaga a importacao do titular" || erro "apagar alheia" ""
[[ "$(lanc $U2 "$C2" "$I1" x 1)" == *"not present in table \"importacoes\""* ]] && ok "lancamento nao aponta para importacao de outro usuario" || erro "fk alheia" ""
[[ "$(nova_importacao $U2 "$C1" invadir.ofx)" == "" ]] && ok "importacao nao aponta para conta de outro usuario" || erro "conta alheia" ""
[[ "$(como authenticated $U1 "update public.importacoes set arquivo = 'x' where id = '$I1'")" == *"permission denied"* ]] && ok "importacao nao pode ser editada" || erro "update" ""
[[ "$(como anon '' "select count(*) from public.importacoes_resumo")" == *"permission denied"* ]] && ok "visitante sem login nao ve nada" || erro "anon" ""
[[ "$(como authenticated $U1 "update public.lancamentos set importacao_id = '$I1' where origem = 'manual'")" == *"lancamentos_importacao_so_importados"* ]] && ok "lancamento manual nao entra numa importacao" || erro "manual em importacao" ""

# Apagar a importacao repetida: so os lancamentos dela somem.
como authenticated $U1 "update public.lancamentos set categoria_id = '$K1' where id_externo = 'a'" >/dev/null
como authenticated $U1 "delete from public.importacoes where id = '$I1'" >/dev/null
r="$(q -d fin_importacoes -c "select string_agg(coalesce(id_externo, 'manual') || ':' || usuario_id::text, ',' order by valor) from public.lancamentos")"
[[ "$r" == "d:$U1,manual:$U1,a:$U2" ]] && ok "apagar a importacao remove so os 3 lancamentos dela (manual, outra importacao e a da outra pessoa ficam)" || erro "cascata" "$r"
[[ "$(q -d fin_importacoes -c "select count(*) from public.importacoes where id = '$I1'")" == "0" ]] && ok "registro da importacao sumiu" || erro "registro" ""
# Depois de apagar, o mesmo extrato pode ser importado de novo (identificadores liberados).
I1c="$(nova_importacao $U1 "$C1" outubro.ofx)"
[[ "$(lanc $U1 "$C1" "$I1c" a 10)" != *"duplicate"* ]] && ok "o mesmo extrato pode ser importado de novo depois de apagado" || erro "reimportar" ""

# Conta sem lancamentos pode ser excluida e leva junto a importacao vazia.
I1d="$(nova_importacao $U1 "$C1b" vazio.ofx)"
como authenticated $U1 "delete from public.contas where id = '$C1b'" >/dev/null
[[ "$(q -d fin_importacoes -c "select count(*) from public.importacoes where id = '$I1d'")" == "0" ]] && ok "excluir conta vazia leva junto a importacao vazia" || erro "conta vazia" ""

# Usuario removido: as importacoes dele somem junto.
q -d fin_importacoes -c "delete from public.lancamentos where usuario_id = '$U2'; delete from auth.users where id = '$U2'" >/dev/null
[[ "$(q -d fin_importacoes -c "select count(*) from public.importacoes where usuario_id = '$U2'")" == "0" ]] && ok "importacoes saem junto com o usuario" || erro "usuario removido" ""

[[ -n "${MANTER:-}" ]] || q -c "drop database fin_importacoes"
[[ $falha == 0 ]] && echo "Historico de importacoes aprovado no banco." || { echo "Historico de importacoes com falhas."; exit 1; }
