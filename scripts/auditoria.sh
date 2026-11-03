#!/usr/bin/env bash
# Auditoria de fora para dentro: confere o site publicado e o Supabase como faria um visitante
# qualquer, só com a chave publicável que já está no site. Não usa nenhuma chave secreta.
# Roda toda semana no GitHub (.github/workflows/auditoria.yml); se algo falhar, o GitHub avisa por e-mail.
set -Euo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${SITE:-https://fbi0l.github.io/financeiro-pessoal/}"
URL="$(grep -o "SUPABASE_URL *= *'[^']*'" "$raiz/app.js" | cut -d"'" -f2)"
KEY="$(grep -o "SUPABASE_KEY *= *'[^']*'" "$raiz/app.js" | cut -d"'" -f2)"
falha=0; ok() { echo "ok    $1"; }; erro() { echo "FALHA $1${2:+: $2}"; falha=1; }
[[ -n "$URL" && -n "$KEY" ]] || { echo "FALHA nao achei URL ou chave no app.js"; exit 1; }
[[ "$KEY" == sb_publishable_* ]] && ok "app.js usa a chave publicavel" || erro "chave do app.js nao e a publicavel"

# 1) Site publicado: mesma versao do repositorio, politica de seguranca e scripts conferidos.
pagina="$(curl -fsS --max-time 30 "$SITE?auditoria=$RANDOM")" || { erro "site fora do ar" "$SITE"; pagina=""; }
versao_repo="$(grep -o 'Versão [0-9.]*' "$raiz/index.html" | head -1)"
versao_site="$(grep -o 'Versão [0-9.]*' <<<"$pagina" | head -1)"
[[ -n "$versao_site" && "$versao_site" == "$versao_repo" ]] && ok "site na mesma versao do repositorio ($versao_site)" || erro "versao do site" "site '$versao_site', repositorio '$versao_repo'"
grep -q 'http-equiv="Content-Security-Policy"' <<<"$pagina" && grep -q "script-src 'self' https://cdn.jsdelivr.net;" <<<"$pagina" \
  && ok "politica de seguranca (CSP) restrita" || erro "CSP ausente ou alterada"
externos="$(grep -o '<script src="https[^>]*>' <<<"$pagina" || true)"
if [[ -z "$externos" ]] || ! grep -v 'integrity="sha384-' <<<"$externos" | grep -q .; then ok "scripts externos com integridade"; else erro "script externo sem integridade"; fi

# 2) Login: cadastro aberto desligado e so e-mail e senha.
cfg="$(curl -fsS --max-time 30 -H "apikey: $KEY" "$URL/auth/v1/settings")" || cfg=""
node -e '
  const c = JSON.parse(process.argv[1] || "{}");
  const ligados = Object.entries(c.external || {}).filter(([, v]) => v).map(([k]) => k);
  if (c.disable_signup !== true) { console.log("FALHA cadastro aberto esta ligado"); process.exit(1); }
  if (ligados.join() !== "email") { console.log("FALHA formas de login inesperadas: " + ligados.join()); process.exit(1); }
  console.log("ok    cadastro aberto desligado, so e-mail e senha");' "$cfg" || falha=1

# 3) Sem login, nenhuma tabela devolve dados.
for t in contas categorias lancamentos importacoes convites saldos_contas importacoes_resumo; do
  corpo="$(curl -sS --max-time 30 -H "apikey: $KEY" "$URL/rest/v1/$t?select=*&limit=1")"
  if [[ "$corpo" =~ ^\[.+\]$ ]]; then erro "tabela $t aberta para visitantes"; else ok "tabela $t fechada para visitantes"; fi
done

# 4) Sem login, nenhuma funcao do banco executa.
for f in criar_convite listar_convites cancelar_convite sou_administrador consumir_uso_ia resumo_periodo; do
  st="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H "apikey: $KEY" -H 'content-type: application/json' -d '{}' "$URL/rest/v1/rpc/$f")"
  [[ "$st" =~ ^(401|403|404)$ ]] && ok "funcao $f recusada sem login ($st)" || erro "funcao $f respondeu $st sem login"
done

# 5) Funcoes do servidor: o assistente exige login e o cadastro recusa convite invalido.
st="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'origin: https://fbi0l.github.io' -H 'content-type: application/json' -d '{"modo":"chat"}' "$URL/functions/v1/agente")"
[[ "$st" == 401 ]] && ok "assistente exige login" || erro "assistente respondeu $st sem login"
st="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'origin: https://site-qualquer.com' -H 'content-type: application/json' -d '{}' "$URL/functions/v1/agente")"
[[ "$st" == 403 ]] && ok "assistente recusa outros sites" || erro "assistente respondeu $st a outro site"
st="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'origin: https://fbi0l.github.io' -H 'content-type: application/json' -d '{"acao":"verificar","codigo":"curto"}' "$URL/functions/v1/registrar-convite")"
[[ "$st" == 400 ]] && ok "cadastro recusa convite invalido" || erro "cadastro respondeu $st a convite invalido"

if [[ $falha == 0 ]]; then echo "Auditoria aprovada."; else echo "Auditoria com falhas: veja as linhas FALHA acima."; exit 1; fi
