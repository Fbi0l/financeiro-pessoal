#!/usr/bin/env bash
# Convites no banco (PostgreSQL de teste, sem tocar no Supabase real): administrador unico,
# codigo nunca guardado (so o hash), limites, cancelamento, permissoes e a reserva usada pela funcao de cadastro.
set -Eeuo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
export PGSSLMODE=disable PGDATABASE=postgres
q() { psql -v ON_ERROR_STOP=1 -qAt "$@"; }
q -c "drop database if exists fin_convites" -c "create database fin_convites"
q -d fin_convites -f "$raiz/tests/supabase-simulado.sql"
# Dois usuarios ja existentes; o mais antigo (u1) e o titular.
q -d fin_convites -c "insert into auth.users (id, email, created_at) values
  ('00000000-0000-0000-0000-0000000000a1','titular@exemplo.com', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000b2','outra@exemplo.com', now())"
for m in "$raiz"/supabase/migrations/*.sql ${CONVITES_SQL:-}; do q -d fin_convites -f "$m"; done

como() { # papel, usuario, sql
  q -d fin_convites -c "begin; set local role $1; select set_config('request.jwt.claim.sub', '$2', true); $3; commit;" 2>&1 | { grep -v "^CONTEXT\|^PL/pgSQL\|^$" || true; } | tail -1; }
U1=00000000-0000-0000-0000-0000000000a1; U2=00000000-0000-0000-0000-0000000000b2
falha=0; ok() { echo "ok  $1"; }; erro() { echo "ERRO $1: $2"; falha=1; }

[[ "$(q -d fin_convites -c 'select usuario_id from privado.administradores')" == "$U1" ]] && ok "titular (usuario mais antigo) e o unico administrador" || erro "administrador" "$(q -d fin_convites -c 'select * from privado.administradores')"
[[ "$(como authenticated $U1 'select public.sou_administrador()')" == "t" ]] && ok "titular se reconhece como administrador" || erro "sou_administrador titular" ""
[[ "$(como authenticated $U2 'select public.sou_administrador()')" == "f" ]] && ok "outro usuario nao e administrador" || erro "sou_administrador outro" ""

r="$(como authenticated $U1 "select codigo || '|' || id || '|' || (expira_em > now() + interval '47 hours') from public.criar_convite('  Ana  ')")"
codigo="${r%%|*}"; resto="${r#*|}"; id="${resto%%|*}"
[[ "$codigo" =~ ^[A-Za-z0-9_-]{43}$ && "${r##*|}" == "true" ]] && ok "convite com codigo de 43 caracteres e validade de 48h" || erro "criar_convite" "$r"
hash="$(printf '%s' "$codigo" | sha256sum | cut -d' ' -f1)"
[[ "$(q -d fin_convites -c "select count(*) from public.convites where codigo_hash = '$hash' and rotulo = 'Ana'")" == "1" ]] && ok "banco guarda so o hash do codigo (e o apelido sem espacos)" || erro "hash" ""
[[ "$(q -d fin_convites -c "select count(*) from public.convites where codigo_hash like '%$codigo%' or rotulo like '%$codigo%'")" == "0" ]] && ok "codigo em si nao aparece em lugar nenhum" || erro "codigo guardado" ""
[[ "$(como authenticated $U1 'select situacao from public.listar_convites()')" == "pendente" ]] && ok "lista mostra o convite pendente" || erro "listar" ""

# Permissoes: outro usuario e visitante nao conseguem nada.
[[ "$(como authenticated $U2 "select * from public.criar_convite('x')")" == *"Somente o administrador"* ]] && ok "outro usuario nao cria convite" || erro "criar por outro" ""
[[ "$(como authenticated $U2 'select * from public.listar_convites()')" == *"Somente o administrador"* ]] && ok "outro usuario nao lista convites" || erro "listar por outro" ""
[[ "$(como authenticated $U2 "select public.cancelar_convite('$id')")" == *"Somente o administrador"* ]] && ok "outro usuario nao cancela convite" || erro "cancelar por outro" ""
[[ "$(como authenticated $U1 'select count(*) from public.convites')" == *"permission denied"* ]] && ok "nem o titular le a tabela direto (so pelas funcoes)" || erro "select direto" ""
[[ "$(como anon '' "select * from public.criar_convite('x')")" == *"permission denied"* ]] && ok "visitante sem login nao executa as funcoes" || erro "anon" ""
[[ "$(como authenticated $U1 "insert into public.convites (codigo_hash) values (repeat('a',64))")" == *"permission denied"* ]] && ok "ninguem do app insere convite sem passar pela funcao" || erro "insert direto" ""
[[ "$(como authenticated $U1 "select * from public.criar_convite(repeat('x', 41))")" == *"40 caracteres"* ]] && ok "apelido longo recusado" || erro "rotulo longo" ""

# Limite de 10 pendentes.
for i in $(seq 2 10); do como authenticated $U1 "select * from public.criar_convite()" >/dev/null; done
[[ "$(como authenticated $U1 "select * from public.criar_convite()")" == *"10 convites pendentes"* ]] && ok "limite de 10 convites pendentes" || erro "limite" ""

# Reserva feita pela funcao de cadastro (service_role): uma vez so; cancelado e vencido nao servem.
reservar() { como service_role '' "update public.convites set usado_em = now() where codigo_hash = '$1' and usado_em is null and cancelado_em is null and expira_em > now() returning id" | grep -c . || true; }
[[ "$(reservar "$hash")" == "1" ]] && ok "service_role reserva o convite valido" || erro "reserva" ""
[[ "$(reservar "$hash")" == "0" ]] && ok "o mesmo convite nao pode ser usado duas vezes" || erro "reuso" ""
como service_role '' "update public.convites set usado_por = '$U2' where id = '$id'" >/dev/null
[[ "$(como authenticated $U1 "select situacao from public.listar_convites() where id = '$id'")" == "usado" ]] && ok "lista mostra o convite como usado" || erro "situacao usado" ""
[[ "$(como authenticated $U1 "select public.cancelar_convite('$id')")" == "f" ]] && ok "convite usado nao pode ser cancelado" || erro "cancelar usado" ""

r2="$(como authenticated $U1 "select codigo || '|' || id from public.criar_convite()")"
c2="${r2%%|*}"; id2="${r2#*|}"; h2="$(printf '%s' "$c2" | sha256sum | cut -d' ' -f1)"
[[ "$(como authenticated $U1 "select public.cancelar_convite('$id2')")" == "t" ]] && ok "titular cancela convite pendente" || erro "cancelar" ""
[[ "$(reservar "$h2")" == "0" ]] && ok "convite cancelado nao funciona" || erro "cancelado reservado" ""
r3="$(como authenticated $U1 "select codigo || '|' || id from public.criar_convite()")"; c3="${r3%%|*}"; id3="${r3#*|}"; h3="$(printf '%s' "$c3" | sha256sum | cut -d' ' -f1)"
q -d fin_convites -c "update public.convites set criado_em = now() - interval '3 days', expira_em = now() - interval '1 hour' where id = '$id3'"
[[ "$(reservar "$h3")" == "0" ]] && ok "convite vencido nao funciona" || erro "vencido reservado" ""
[[ "$(como authenticated $U1 "select situacao from public.listar_convites() where id = '$id3'")" == "vencido" ]] && ok "lista mostra vencido" || erro "situacao vencido" ""

# Reservado sem registrar quem usou: "em uso" por 10 minutos, depois aparece como usado.
r4="$(como authenticated $U1 "select codigo || '|' || id from public.criar_convite()")"; id4="${r4#*|}"
q -d fin_convites -c "update public.convites set usado_em = now() where id = '$id4'"
[[ "$(como authenticated $U1 "select situacao from public.listar_convites() where id = '$id4'")" == "em_uso" ]] && ok "reservado agora aparece em uso" || erro "situacao em uso" ""
q -d fin_convites -c "update public.convites set usado_em = now() - interval '20 minutes' where id = '$id4'"
[[ "$(como authenticated $U1 "select situacao from public.listar_convites() where id = '$id4'")" == "usado" ]] && ok "em uso nao fica preso" || erro "em uso preso" ""

q -c "drop database fin_convites"
[[ $falha == 0 ]] && echo "Convites aprovados no banco." || { echo "Convites com falha."; exit 1; }
