#!/usr/bin/env bash
# Backup lógico criptografado do app financeiro (adaptado do Inventário).
# BACKUP_SCOPE=dados (padrão): estrutura e dados dos esquemas public e privado
#   (o privado guarda as funções usadas pelos gatilhos das tabelas do public).
# BACKUP_SCOPE=auth: só os DADOS de auth.users e auth.identities (contas de login, com hash da senha),
#   para recriar o acesso em um projeto Supabase novo.
# Não inclui configurações do Auth nem o gatilho em auth.users (ele está em supabase/migrations).
# PG_CLIENT=docker (padrão, usa clientes PostgreSQL 18 compatíveis com o Supabase 17) ou local.
set -Eeuo pipefail
umask 077

for nome in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE BACKUP_AGE_RECIPIENT BACKUP_OUTPUT_DIR; do
  if [[ -z "${!nome:-}" ]]; then echo "::error::Configuracao obrigatoria ausente: $nome" >&2; exit 2; fi
done
if [[ ! "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]]; then
  echo "::error::BACKUP_AGE_RECIPIENT deve ser uma chave publica age1..." >&2; exit 2
fi
escopo="${BACKUP_SCOPE:-dados}"
[[ "$escopo" == dados || "$escopo" == auth ]] || { echo "::error::BACKUP_SCOPE deve ser dados ou auth" >&2; exit 2; }
cliente="${PG_CLIENT:-docker}"
command -v age >/dev/null || { echo "::error::age nao esta disponivel" >&2; exit 2; }

mkdir -p "$BACKUP_OUTPUT_DIR"
saida="$(cd "$BACKUP_OUTPUT_DIR" && pwd -P)"
chmod 700 "$saida"
base="financeiro_${escopo}_$(date -u +'%Y-%m-%d_%H-%M-%SZ')"
bruto="$saida/$base.dump"
cifrado="$saida/$base.dump.age"
trap 'rm -f -- "$bruto"' EXIT

export PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-20}"
pg() {
  if [[ "$cliente" == docker ]]; then
    docker run --rm --network host -v "$saida:/backup" \
      -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGCONNECT_TIMEOUT \
      postgres:18 "$@"
  else
    # Modo local (testes): troca o caminho /backup pela pasta real.
    "${@//\/backup/$saida}"
  fi
}

if [[ "$escopo" == dados ]]; then
  echo "Gerando backup dos esquemas public e privado..."
  # Com as permissoes (GRANT/REVOKE): sem elas o app perderia o acesso as tabelas apos restaurar.
  pg pg_dump --schema=public --schema=privado --format=custom --no-owner --file="/backup/$base.dump"
else
  echo "Gerando backup dos dados das contas de login..."
  pg pg_dump --data-only --table=auth.users --table=auth.identities --format=custom --no-owner --no-acl --file="/backup/$base.dump"
fi
[[ -s "$bruto" ]] || { echo "::error::Backup inexistente ou vazio" >&2; exit 1; }

echo "Conferindo se o arquivo pode ser lido por inteiro..."
indice="$(pg pg_restore --list "/backup/$base.dump")"
pg pg_restore --file=/dev/null "/backup/$base.dump" >/dev/null
if [[ "$escopo" == dados ]]; then
  for tabela in contas categorias lancamentos; do
    grep -qE "TABLE DATA public $tabela " <<<"$indice" || { echo "::error::Backup sem os dados de $tabela" >&2; exit 1; }
  done
  grep -qE "FUNCTION privado tocar_atualizado_em" <<<"$indice" || { echo "::error::Backup sem as funcoes do esquema privado" >&2; exit 1; }
else
  [[ "$(grep -cE 'TABLE DATA auth (users|identities) ' <<<"$indice" || true)" -eq 2 ]] || { echo "::error::Backup sem auth.users ou auth.identities" >&2; exit 1; }
fi

echo "Criptografando com a chave publica age..."
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$cifrado" "$bruto"
[[ -s "$cifrado" ]] || { echo "::error::Backup criptografado vazio" >&2; exit 1; }
rm -f -- "$bruto"
( cd "$saida" && sha256sum "$base.dump.age" > "$base.dump.age.sha256" && sha256sum -c "$base.dump.age.sha256" )
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { printf 'backup_name=%s\n' "$base.dump.age"; printf 'checksum_name=%s\n' "$base.dump.age.sha256"; } >> "$GITHUB_OUTPUT"
fi
echo "Backup ($escopo) criptografado e conferido: $base.dump.age"
