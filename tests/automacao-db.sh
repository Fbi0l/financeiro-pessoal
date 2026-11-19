#!/usr/bin/env bash
# Lançamentos automáticos pelo e-mail do banco (PostgreSQL de teste, sem tocar no Supabase real):
# entrada, saída e transferência com data; mesmo e-mail não duplica; não duplica o que já foi lançado à mão;
# validações; só na conta do dono da chave; função interna fora da API.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }
q -c "drop database if exists fin_automacao" -c "create database fin_automacao"
q -d fin_automacao -f "$raiz/tests/supabase-simulado.sql"
# Como no Supabase: funcoes novas do esquema public ganham EXECUTE para anon e authenticated.
q -d fin_automacao -c "alter default privileges in schema public grant execute on functions to anon, authenticated"
for m in "$raiz"/supabase/migrations/*.sql; do q -d fin_automacao -f "$m"; done
U1=00000000-0000-0000-0000-0000000000a1; U2=00000000-0000-0000-0000-0000000000b2
q -d fin_automacao -c "insert into auth.users (id, email) values ('$U1','a@exemplo.com'), ('$U2','b@exemplo.com')"
q -d fin_automacao -c "insert into public.contas (usuario_id, nome, tipo) values ('$U1','Nubank PJ','corrente')"
como() { { q -d fin_automacao -c "begin; set local role $1; select set_config('request.jwt.claim.sub', '$2', true); $3; commit;" 2>&1 || true; } | { grep -v "^CONTEXT\|^PL/pgSQL\|^LINE\|^ *\^\|^$\|^SQL statement\|^BEGIN\|^COMMIT" || true; } | tail -1; }
falha=0; ok() { echo "ok  $1"; }; erro() { echo "ERRO $1: $2"; falha=1; }
sql() { q -d fin_automacao -c "$1"; }
HOJE=$(sql "select (now() at time zone 'America/Belem')::date")
ONTEM=$(sql "select (now() at time zone 'America/Belem')::date - 1")

K1=$(como authenticated "$U1" "select chave from public.criar_chave_atalho('Automação e-mail')")
L() { como anon "" "select public.automacao_lancar('$K1', $1)"; }

# Entrada (reembolso) com a data do e-mail e categoria padrão.
r=$(L "'receita', 'R\$ 7,40', 'Reembolso 99', 'Nubank', '$ONTEM', 'email:m1'")
[[ "$r" == "Entrada lançada: R\$ 7,40 em Nubank (Outras receitas, "* ]] && ok "entrada com data do e-mail" || erro "entrada" "$r"
r=$(sql "select data||'|'||origem||'|'||id_externo||'|'||observacoes from public.lancamentos where id_externo = 'email:m1'")
[[ "$r" == "$ONTEM|importacao|email:m1|Lançado automaticamente pelo e-mail do banco." ]] && ok "gravado com codigo do e-mail" || erro "gravado" "$r"

# Mesmo e-mail de novo: não duplica.
r=$(L "'receita', '7,40', 'Reembolso 99', 'Nubank', '$ONTEM', 'email:m1'")
[[ "$r" == "Já registrado"* ]] && ok "mesmo e-mail nao duplica" || erro "repetido" "$r"

# Transferência entre contas do dono.
r=$(L "'transferencia', '130,00', 'Pix para Fábio', 'Nubank PJ', '$HOJE', 'email:m2', 'Nubank'")
[[ "$r" == "Transferência lançada: R\$ 130,00 de Nubank PJ para Nubank ("* ]] && ok "transferencia" || erro "transf" "$r"
r=$(sql "select (select nome from public.contas where id = conta_destino_id)||'|'||coalesce(categoria_id::text,'sem') from public.lancamentos where id_externo = 'email:m2'")
[[ "$r" == "Nubank|sem" ]] && ok "transferencia com destino e sem categoria" || erro "transf dados" "$r"
r=$(sql "select saldo_atual from public.saldos_contas where id = (select id from public.contas where usuario_id = '$U1' and nome = 'Nubank PJ')")
[[ "$r" == "-130.00" ]] && ok "saldo da origem cai" || erro "saldo" "$r"

# Já lançado à mão (mesma conta, tipo, valor; data com 1 dia de folga): não duplica.
sql "insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id) select '$U1','despesa','Uber',28.40,'$ONTEM',id from public.contas where usuario_id='$U1' and nome='Nubank'"
r=$(L "'despesa', '28,40', 'Pix 99 Tecnologia', 'Nubank', '$HOJE', 'email:m3'")
[[ "$r" == "Já existia: R\$ 28,40 em Nubank"* ]] && ok "nao duplica o lancado a mao" || erro "parecido" "$r"
r=$(sql "select count(*) from public.lancamentos where valor = 28.40")
[[ "$r" == 1 ]] && ok "continua um so" || erro "duplicou" "$r"
# Mesmo valor em outra conta ou outro tipo é outro movimento.
r=$(L "'receita', '28,40', 'Devolução', 'Nubank', '$HOJE', 'email:m4'")
[[ "$r" == "Entrada lançada"* ]] && ok "outro tipo nao conta como repetido" || erro "outro tipo" "$r"
# Transferência igual já lançada à mão.
sql "insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, conta_destino_id) select '$U1','transferencia','Pix',200,'$ONTEM',(select id from public.contas where usuario_id='$U1' and nome='Nubank PJ'),(select id from public.contas where usuario_id='$U1' and nome='Nubank')"
r=$(L "'transferencia', '200', 'Pix para Fábio', 'Nubank PJ', '$ONTEM', 'email:m5', 'Nubank'")
[[ "$r" == "Já existia"* ]] && ok "transferencia lancada a mao nao duplica" || erro "transf parecida" "$r"

# Categoria aprendida pela descrição.
sql "insert into public.lancamentos (usuario_id, tipo, descricao, valor, data, conta_id, categoria_id) select '$U1','receita','Estorno Loja X',1.16,'$HOJE'::date - 10,(select id from public.contas where usuario_id='$U1' and nome='Nubank'),(select id from public.categorias where usuario_id='$U1' and nome='Pix recebido')"
r=$(L "'receita', '3,50', 'Estorno Loja X', 'Nubank', '$HOJE', 'email:m6'")
[[ "$r" == *"(Pix recebido, "* ]] && ok "categoria aprendida" || erro "categoria" "$r"

# Validações.
r=$(L "'receita', '5', 'x', 'Nubank', '$HOJE'::date + 1, 'email:m7'")
[[ "$r" == *"Data inválida"* ]] && ok "recusa data futura" || erro "futuro" "$r"
r=$(L "'receita', '5', 'x', 'Nubank', '$HOJE'::date - 61, 'email:m7'")
[[ "$r" == *"Data inválida"* ]] && ok "recusa data muito antiga" || erro "antiga" "$r"
r=$(L "'receita', '5', 'x', 'Nubank', '$HOJE', ''")
[[ "$r" == *"código do movimento"* ]] && ok "exige codigo" || erro "codigo" "$r"
r=$(L "'pix', '5', 'x', 'Nubank', '$HOJE', 'email:m8'")
[[ "$r" == *"Tipo inválido"* ]] && ok "recusa tipo" || erro "tipo" "$r"
r=$(L "'transferencia', '5', 'x', 'Nubank', '$HOJE', 'email:m8', 'Nubank'")
[[ "$r" == *"destino"* ]] && ok "recusa transferencia para a mesma conta" || erro "mesma conta" "$r"
r=$(L "'despesa', 'abc', 'x', 'Nubank', '$HOJE', 'email:m8'")
[[ "$r" == *"Valor inválido"* ]] && ok "recusa valor" || erro "valor" "$r"
r=$(como anon "" "select public.automacao_lancar('errada', 'receita', '5', 'x', 'Nubank', '$HOJE', 'email:m9')")
[[ "$r" == *"Chave inválida"* ]] && ok "recusa chave errada" || erro "chave" "$r"

# Só na conta do dono: a chave de outra pessoa não acha as contas do primeiro... e lança nas próprias.
K2=$(como authenticated "$U2" "select chave from public.criar_chave_atalho()")
r=$(como anon "" "select public.automacao_lancar('$K2', 'receita', '9', 'x', 'Nubank PJ', '$HOJE', 'email:m10')")
[[ "$r" == *"não encontrada"* ]] && ok "nao enxerga conta de outra pessoa" || erro "isolamento" "$r"
como anon "" "select public.automacao_lancar('$K2', 'receita', '9', 'x', 'Nubank', '$HOJE', 'email:m1')" >/dev/null
r=$(sql "select count(*) from public.lancamentos where id_externo = 'email:m1'")
[[ "$r" == 2 ]] && ok "mesmo codigo em pessoas diferentes nao se mistura" || erro "codigo por pessoa" "$r"

# Função interna fora da API; chave cancelada para de funcionar.
r=$(como anon "" "select privado.categoria_aprendida('$U1','receita','x')")
[[ "$r" == *"permission denied"* ]] && ok "funcao interna fora da API" || erro "interna" "$r"
ID1=$(sql "select id from privado.chaves_atalho where usuario_id = '$U1'")
como authenticated "$U1" "select public.cancelar_chave_atalho('$ID1')" >/dev/null
r=$(L "'receita', '5', 'x', 'Nubank', '$HOJE', 'email:m11'")
[[ "$r" == *"Chave inválida"* ]] && ok "chave cancelada para a automacao" || erro "cancelada" "$r"

q -c "drop database fin_automacao"
[[ $falha == 0 ]] && echo "Automacao por e-mail aprovada no banco."
exit $falha
