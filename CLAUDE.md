# Financeiro pessoal — guia para o Claude

App de finanças pessoais do Fabio. Site estático (HTML, CSS e JavaScript puros, sem build) com Supabase para banco, login e regras de acesso, publicado no GitHub Pages e instalável no celular (PWA). Responda sempre em português do Brasil, em linguagem simples: o dono não é programador.

## Onde fica cada coisa

- Site: https://fbi0l.github.io/financeiro-pessoal/ (publica sozinho a cada envio para `main`).
- Supabase: projeto `financeiro-pessoal`, ref `ruphlnabikvnadlmeisg` (São Paulo, plano gratuito).
- `index.html`, `styles.css`, `app.js` (telas e lógica), `importar.js` (leitura de extratos OFX/CSV), `sw.js` (app instalável).
- `supabase/migrations/`: histórico do banco. O nome de cada arquivo usa a versão registrada no Supabase.
- `supabase/functions/agente/`: assistente com IA (Cloudflare Workers AI ou Groq). `supabase/functions/registrar-convite/`: cadastro por convite.
- `README.md`: o que mudou em cada versão. `BACKUP.md`: como ligar e restaurar o backup.

## Regras que não podem ser quebradas

- Toda tabela com dados do usuário tem RLS por `usuario_id = (select auth.uid())`. Tabela nova segue o mesmo padrão; tabela interna vai para o esquema `privado` (fora da API).
- No site só entra a chave publicável (`sb_publishable_…`). `service_role` e `sb_secret_…` nunca entram no repositório; o teste `tests/seguranca-site.cjs` falha se aparecerem.
- Nada de HTML montado a partir de dados (`innerHTML` etc.): use `el()` / `textContent`. CSP sem `unsafe-inline`; script externo só com versão exata e `integrity`.
- Funções `security definer` sempre com `set search_path = ''` e conferindo quem chamou.
- Campos de texto com fonte de 16px no celular (abaixo disso o iPhone dá zoom e atrapalha).

## Versão

A versão aparece em `index.html` (rodapés e `?v=` dos arquivos), `sw.js` (nome do cache e lista de arquivos) e `package.json`. Ao publicar uma mudança visível, suba a versão em todos esses lugares e registre no topo do `README.md`. O teste do site confere que estão iguais.

## Avisos de novidade (pedido do dono)

Toda mudança que afeta a experiência de uso (tela nova, botão novo, algo que muda de lugar ou de jeito) ganha um aviso curto no app: acrescente um item no topo de `NOVIDADES` em `app.js`, com a versão nova, um título como "Agora temos o modo escuro" e uma frase dizendo onde encontrar. Correções invisíveis e mudanças só de banco não precisam de aviso.

## Testes

- `npm test`: lógica, importação, agente, convites e segurança do site (não usa rede nem Supabase).
- Testes de banco (PostgreSQL local, via `tests/supabase-simulado.sql`): `tests/convites-db.sh`, `tests/importacoes-db.sh`, `tests/limite-ia-db.sh`, `tests/backup-restauracao.sh`. Rodam no GitHub em "Teste do backup".
- `scripts/auditoria.sh`: confere de fora o site e o Supabase publicados; roda toda segunda no GitHub.
- Mudou algo? Rode `npm test` antes de enviar e acrescente um teste para o caso novo.

## Como publicar

1. Banco: migração nova em `supabase/migrations/` (aplique no Supabase e use a versão que ele registrar no nome do arquivo).
2. Funções: publique `agente` e `registrar-convite` (ambas com verificação de JWT desligada: elas conferem o login por conta própria).
3. Site: envie para `main` e confira que o rodapé mostra a versão nova.
Ordem: banco → funções → site, para nada quebrar no meio. Publicar em produção sempre com o OK do dono.

## Pendências (04/11/2026)

- Backup diário ligado em 04/11/2026 (06h, 30 dias de cópias). A chave privada fica no computador do dono em `BackupsFinanceiro\chave-privada-backup-age.txt`; restauração da criptografia testada pelo dono em 04/11/2026.
- Supabase: senha mínima de 10 caracteres; apagar a função antiga `agente-diagnostico`.
- Próximas etapas: cartão de crédito (fatura, parcelas, pagamento sem contar em dobro) ou limites por categoria.
