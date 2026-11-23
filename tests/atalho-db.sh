#!/usr/bin/env bash
# Lançar pelo celular (PostgreSQL de teste, sem tocar no Supabase real):
# chave só do dono, só inclui lançamentos, valor no formato do celular, categoria aprendida,
# toque repetido, limite diário, cancelamento e chaves fora da API.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }
q -c "drop database if exists fin_atalho" -c "create database fin_atalho"
q -d fin_atalho -f "$raiz/tests/supabase-simulado.sql"
# Como no Supabase: funcoes novas do esquema public ganham EXECUTE para anon e authenticated (a migracao precisa tirar).
q -d fin_atalho -c "alter default privileges in schema public grant execute on functions to anon, authenticated"
for m in "$raiz"/supabase/migrations/*.sql; do q -d fin_atalho -f "$m"; done
U1=00000000-0000-0000-0000-0000000000a1; U2=00000000-0000-0000-0000-0000000000b2
q -d fin_atalho -c "insert into auth.users (id, email) values ('$U1','a@exemplo.com'), ('$U2','b@exemplo.com')"
como() { { q -d fin_atalho -c "begin; set local role $1; select set_config('request.jwt.claim.sub', '$2', true); $3; commit;" 2>&1 || true; } | { grep -v "^CONTEXT\|^PL/pgSQL\|^LINE\|^ *\^\|^$\|^SQL statement\|^BEGIN\|^COMMIT" || true; } | tail -1; }
falha=0; ok() { echo "ok  $1"; }; erro() { echo "ERRO $1: $2"; falha=1; }
sql() { q -d fin_atalho -c "$1"; }

# Criar chave: só logado; a chave aparece uma vez e o banco guarda só o hash.
K1=$(como authenticated "$U1" "select chave from public.criar_chave_atalho('iPhone')")
[[ "$K1" =~ ^[A-Za-z0-9_-]{43}$ ]] && ok "chave de 43 caracteres" || erro "chave" "$K1"
r=$(sql "select count(*) from privado.chaves_atalho where chave_hash = encode(sha256(convert_to('$K1','UTF8')),'hex') and apelido = 'iPhone'")
[[ "$r" == 1 ]] && ok "banco guarda so o hash" || erro "hash" "$r"
r=$(sql "select count(*) from privado.chaves_atalho where chave_hash = '$K1'")
[[ "$r" == 0 ]] && ok "chave em texto nao fica no banco" || erro "texto" "$r"
r=$(como anon "" "select * from public.criar_chave_atalho()")
[[ "$r" == *"permission denied"* ]] && ok "anonimo nao cria chave" || erro "anon cria" "$r"
r=$(como anon "" "select count(*) from public.listar_chaves_atalho()")
[[ "$r" == *"permission denied"* ]] && ok "anonimo nao lista chaves" || erro "anon lista" "$r"
r=$(como authenticated "" "select * from public.criar_chave_atalho()")
[[ "$r" == *"Entre no app"* ]] && ok "sem login nao cria" || erro "sem login" "$r"
r=$(como authenticated "$U1" "select count(*) from privado.chaves_atalho")
[[ "$r" == *"permission denied"* ]] && ok "tabela de chaves fora da API" || erro "tabela exposta" "$r"

# Contas do dono da chave (sem login, com a chave).
r=$(como anon "" "select string_agg(n, ',') from public.atalho_contas('$K1') n")
[[ "$r" == "Banpará,Espécie,Itaú,Nubank" ]] && ok "lista as contas do dono" || erro "contas" "$r"
r=$(como anon "" "select * from public.atalho_contas('chave-errada')")
[[ "$r" == *"Chave inválida"* ]] && ok "chave errada recusada" || erro "chave errada" "$r"

# Lançar: valor no formato do celular, conta pelo nome (sem diferenciar maiúsculas).
r=$(como anon "" "select public.atalho_lancar('$K1', 'R\$ 1.234,56', 'Mercado Formosa', 'nubank')")
[[ "$r" == "Gasto lançado: R\$ 1.234,56 em Nubank (Outras despesas)." ]] && ok "lanca gasto (sem historico: Outras despesas)" || erro "lancar" "$r"
r=$(sql "select usuario_id||'|'||tipo||'|'||valor||'|'||pago||'|'||origem||'|'||(data = (now() at time zone 'America/Belem')::date) from public.lancamentos where descricao = 'Mercado Formosa'")
[[ "$r" == "$U1|despesa|1234.56|true|manual|true" ]] && ok "gravado na conta do dono, pago, data de hoje" || erro "gravado" "$r"
for par in "12,50:12.50" "12.5:12.50" "7:7.00" "1.234:1234.00" "-9,90:9.90" "R\$12:12.00"; do
  r=$(sql "select privado.ler_valor_atalho('${par%%:*}')")
  [[ "$r" == "${par##*:}" ]] && ok "le valor ${par%%:*}" || erro "valor ${par%%:*}" "$r"
done
for ruim in "" "0" "1,2,3" "R\$"; do
  r=$(como anon "" "select public.atalho_lancar('$K1', '$ruim', 'x', 'Nubank')")
  [[ "$r" == *"Valor inválido"* ]] && ok "recusa valor '$ruim'" || erro "valor ruim $ruim" "$r"
done
# Automação da Carteira com o nome da loja no campo do valor: a mensagem explica como corrigir.
for loja in "Mais Barato Grao" "abc"; do
  r=$(como anon "" "select public.atalho_lancar('$K1', '$loja', '$loja', 'Nubank')")
  [[ "$r" == *"O valor chegou como \"$loja\", que parece o nome da loja"*'escolha "Valor"'* ]] && ok "explica valor com nome da loja '$loja'" || erro "nome da loja $loja" "$r"
done
r=$(sql "select count(*) from public.lancamentos where descricao = 'Mais Barato Grao'")
[[ "$r" == 0 ]] && ok "nome da loja no valor nao grava nada" || erro "gravou com nome da loja" "$r"

# Categoria aprendida: mesma descrição, depois mesma primeira palavra.
sql "insert into public.lancamentos (usuario_id, tipo, descricao, valor, conta_id, categoria_id)
     select '$U1', 'despesa', 'Uber', 10, (select id from public.contas where usuario_id='$U1' and nome='Nubank'),
            (select id from public.categorias where usuario_id='$U1' and nome='Transporte')"
r=$(como anon "" "select public.atalho_lancar('$K1', '23,40', 'uber', 'Nubank')")
[[ "$r" == *"(Transporte)." ]] && ok "categoria pela mesma descricao" || erro "cat descricao" "$r"
r=$(como anon "" "select public.atalho_lancar('$K1', '18', 'Uber Eats lanche', 'Nubank')")
[[ "$r" == *"(Transporte)." ]] && ok "categoria pela primeira palavra" || erro "cat palavra" "$r"
r=$(como anon "" "select public.atalho_lancar('$K1', '50', 'Pix recebido', 'Nubank', 'entrada')")
[[ "$r" == "Entrada lançada: R\$ 50,00 em Nubank (Outras receitas)." ]] && ok "entrada (para o Android)" || erro "entrada" "$r"

# Toque repetido não duplica.
r=$(como anon "" "select public.atalho_lancar('$K1', '23,40', 'uber', 'Nubank')")
[[ "$r" == "Já estava lançado"* ]] && ok "toque repetido nao duplica" || erro "repetido" "$r"
r=$(sql "select count(*) from public.lancamentos where descricao = 'uber'")
[[ "$r" == 1 ]] && ok "so um lancamento" || erro "duplicou" "$r"

# Conta inexistente: mensagem com as contas; sem conta, só quando há uma única conta ativa.
r=$(como anon "" "select public.atalho_lancar('$K1', '5', 'x', 'Caixa')")
[[ "$r" == *'Conta "Caixa" não encontrada. Suas contas: Banpará, Espécie, Itaú, Nubank.'* ]] && ok "conta errada explica" || erro "conta errada" "$r"
r=$(como anon "" "select public.atalho_lancar('$K1', '5', 'x')")
[[ "$r" == *"não encontrada"* ]] && ok "sem conta e com varias contas recusa" || erro "sem conta" "$r"
sql "update public.contas set arquivada = true where usuario_id = '$U1' and nome <> 'Nubank'"
r=$(como anon "" "select public.atalho_lancar('$K1', '5', 'Cafe')")
[[ "$r" == *"em Nubank"* ]] && ok "sem conta usa a unica ativa" || erro "unica conta" "$r"
sql "update public.contas set arquivada = false where usuario_id = '$U1'"

# Uma pessoa não lança na conta da outra, nem vê as contas dela.
K2=$(como authenticated "$U2" "select chave from public.criar_chave_atalho()")
como anon "" "select public.atalho_lancar('$K2', '3', 'Pao', 'Nubank')" >/dev/null
r=$(sql "select count(*) from public.lancamentos l join public.contas c on c.id = l.conta_id where l.descricao = 'Pao' and l.usuario_id = '$U2' and c.usuario_id = '$U2'")
[[ "$r" == 1 ]] && ok "cada chave lanca so na propria conta" || erro "isolamento" "$r"
r=$(como authenticated "$U2" "select count(*) from public.listar_chaves_atalho()")
[[ "$r" == 1 ]] && ok "lista so as proprias chaves" || erro "lista" "$r"
ID1=$(sql "select id from privado.chaves_atalho where usuario_id = '$U1'")
r=$(como authenticated "$U2" "select public.cancelar_chave_atalho('$ID1')")
[[ "$r" == f ]] && ok "nao cancela chave de outra pessoa" || erro "cancela alheia" "$r"
r=$(como anon "" "select public.cancelar_chave_atalho('$ID1')")
[[ "$r" == *"permission denied"* ]] && ok "anonimo nao cancela" || erro "anon cancela" "$r"

# A chave não dá acesso a ler nada: só as funções do atalho.
r=$(como anon "" "select count(*) from public.lancamentos")
[[ "$r" == *"permission denied"* || "$r" == 0 ]] && ok "anonimo nao le lancamentos" || erro "le" "$r"
r=$(como anon "" "select privado.dono_da_chave('$K1')")
[[ "$r" == *"permission denied"* ]] && ok "funcao interna fora da API" || erro "interna" "$r"

# Limite diário por chave.
sql "update privado.chaves_atalho set uso_dia = (now() at time zone 'America/Belem')::date, uso_qtd = 60 where id = '$ID1'"
r=$(como anon "" "select public.atalho_lancar('$K1', '1', 'limite', 'Nubank')")
[[ "$r" == *"Limite de 60"* ]] && ok "limite diario" || erro "limite" "$r"
sql "update privado.chaves_atalho set uso_dia = (now() at time zone 'America/Belem')::date - 1 where id = '$ID1'"
r=$(como anon "" "select public.atalho_lancar('$K1', '1', 'novo dia', 'Nubank')")
[[ "$r" == "Gasto lançado"* ]] && ok "limite zera no dia seguinte" || erro "novo dia" "$r"

# Cancelar: a chave para de funcionar na hora.
r=$(como authenticated "$U1" "select public.cancelar_chave_atalho('$ID1')")
[[ "$r" == t ]] && ok "dono cancela a chave" || erro "cancelar" "$r"
r=$(como anon "" "select public.atalho_lancar('$K1', '1', 'depois', 'Nubank')")
[[ "$r" == *"Chave inválida ou cancelada"* ]] && ok "chave cancelada nao lanca" || erro "cancelada" "$r"
r=$(como authenticated "$U1" "select count(*) from public.listar_chaves_atalho()")
[[ "$r" == 0 ]] && ok "cancelada some da lista" || erro "lista apos cancelar" "$r"

# No máximo 5 chaves ativas.
for i in 1 2 3 4 5; do como authenticated "$U1" "select 1 from public.criar_chave_atalho()" >/dev/null; done
r=$(como authenticated "$U1" "select 1 from public.criar_chave_atalho()")
[[ "$r" == *"5 chaves ativas"* ]] && ok "maximo de 5 chaves" || erro "max" "$r"

# Apagar o usuário apaga as chaves.
sql "delete from auth.users where id = '$U2'"
r=$(sql "select count(*) from privado.chaves_atalho where usuario_id = '$U2'")
[[ "$r" == 0 ]] && ok "chaves saem junto com o usuario" || erro "cascade" "$r"

q -c "drop database fin_atalho"
[[ $falha == 0 ]] && echo "Lancar pelo celular aprovado no banco."
exit $falha
