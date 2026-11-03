# financeiro-pessoal

App para registrar, entender e controlar os próprios gastos. É um site estático (HTML, CSS e JavaScript, sem etapa de build) que usa o Supabase para banco de dados, login e regras de acesso. Funciona no computador e no celular.

## Versão 0.7.1 — Extrato do Banco do Brasil

- **CSV do Banco do Brasil** reconhecido nos dois formatos (atual, com "Detalhes" e "Tipo Lançamento", e o antigo, com "Dependencia Origem"). O **OFX** do BB já funcionava.
- A descrição junta o lançamento com os detalhes (ex.: "Pix - Enviado - Maria Souza"), o que melhora a sugestão de categoria.
- A coluna "Tipo Lançamento" (Entrada/Saída) decide o sinal do valor.
- **Correção:** a lista de contas da importação ficava vazia quando a página abria sem o botão "Importar extrato" (ao recarregar ou reabrir o app). Agora ela é preenchida sempre que a página abre e quando as contas carregam.
- **Correção para todos os bancos:** número de documento não é mais tratado como identificador único sozinho (o BB repete números em tarifas e Pix); ele só identifica junto com a data e o valor, então nenhum lançamento novo é descartado por engano como "já importado".

## Versão 0.7.0 — Convites e versão dentro do app

- **Convites (só o titular):** em Início, o painel **Convites** gera um link de uso único que vale 48 horas. A pessoa abre o link, escolhe e-mail e senha e entra com **finanças próprias e separadas** (contas e categorias padrão criadas na hora). Ela não vê nada do titular, e o titular não vê nada dela.
- O link guarda um código aleatório de 43 caracteres; o banco só conhece o hash SHA-256 dele. Convites podem ser cancelados antes do uso; no máximo 10 pendentes.
- A conta é criada pela função `registrar-convite`, que reserva o convite numa única operação (o mesmo link não serve duas vezes), recusa senhas já vazadas (Have I Been Pwned, por k-anonimato) e não revela se um e-mail já existe.
- O painel só aparece para o administrador (`privado.administradores`); as funções do banco também conferem isso.
- **Versão dentro do app:** além da tela de login, a versão aparece no menu lateral e no rodapé.

## Versão 0.6.0 — Contas e categorias editáveis

- **Contas:** criar, editar (nome, tipo, cor), arquivar, desarquivar e excluir (só sem lançamentos; as outras podem ser arquivadas).
- **Saldo de hoje no banco:** ao editar uma conta, digite o saldo que aparece no app do banco. O Financeiro recalcula o **saldo inicial** para bater, sem mexer em nenhum lançamento. Aceita zero e saldo negativo.
- **Categorias:** criar (de saída ou de entrada), renomear, trocar a cor, arquivar e excluir (só sem lançamentos). O tipo de uma categoria existente não muda, por causa da regra do banco que liga a categoria ao tipo do lançamento.
- Categorias arquivadas somem dos formulários e da importação, mas lançamentos antigos continuam mostrando e podem manter a categoria ao serem editados.
- Mensagens claras para nome repetido e para exclusão de item em uso. A confirmação de exclusão virou uma janela única, reaproveitada em todo o app.

## Versão 0.5.0 — App instalável

- O app pode ser **instalado** na área de trabalho (Windows, com Edge ou Chrome) e na tela inicial do celular (Android e iPhone). Ele abre em janela própria, com ícone e nome "Financeiro".
- Atalhos no ícone (clique direito ou toque longo): Novo lançamento, Importar extrato e Assistente.
- O **service worker** (`sw.js`) guarda só os arquivos do próprio site, para abrir rápido. Ele **nunca guarda nada do Supabase** (login, lançamentos, IA), e o teste de segurança confere isso. Com internet, sempre busca a versão mais nova.
- A cada versão, a mesma numeração vai no `index.html` (`?v=`) e no `sw.js` (lista e nome do cache). O teste de segurança acusa se ficarem diferentes.

## Versão 0.4.0 — Assistente com IA

- **Menu Assistente:**
  - **Análise do mês:** resumo e cartões com alertas, economias estimadas, pontos positivos e dicas. Os números são calculados pelo app (em centavos); a IA só interpreta.
  - **Chat:** perguntas livres ("quanto gastei com Uber em outubro?"). A IA consulta seus lançamentos por ferramentas **só de leitura**, com limites de período e quantidade.
- **Onde roda:** função `agente` no Supabase (`supabase/functions/agente`). Exige login e lê apenas os dados do usuário (regras de acesso do banco). Só aceita chamadas do site do app. Não grava nada e não registra dados financeiros em log.
- **IA:** Cloudflare Workers AI (modelo `gpt-oss-120b`), no plano gratuito. A Cloudflare declara que não guarda nem usa os dados para treinar modelos. Também aceita o Groq: basta trocar os segredos.
- **Segredos** (no Supabase, nunca no código): `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_AI_TOKEN` (ou `GROQ_API_KEY`). Opcional: `AGENTE_MODELO`.
- Descrições de extrato são tratadas como dados: a IA é instruída a ignorar textos que pareçam instruções, as ferramentas não alteram nada e as respostas aparecem como texto puro.
- Ao atingir o limite gratuito do dia, o app avisa e volta a funcionar no dia seguinte, sem cobrança.

## Versão 0.3.0 — Importação de extrato

- **Lançamentos → Importar extrato:** escolha a conta e o arquivo **OFX** ou **CSV** (Nubank ou genérico, com `;` ou `,`, colunas de valor ou de crédito/débito). O arquivo é lido no próprio aparelho.
- **Prévia antes de gravar:** cada movimento com data, valor e categoria sugerida, que você pode trocar ou desmarcar.
- **Categoria sugerida** pelo seu histórico (o mesmo estabelecimento já categorizado antes) ou por palavras-chave (Uber, iFood, farmácias, supermercados de Belém, assinaturas…). O que não for reconhecido vai para "Outras".
- **Nada duplica:** cada movimento guarda o identificador do banco (ou data+valor+descrição). Reimportar o mesmo arquivo, ou um período que se sobrepõe, só traz o que é novo. Movimentos com a mesma data e valor de um lançamento feito à mão vêm desmarcados.
- Linhas de saldo são ignoradas; acentos de arquivos em Windows-1252 são lidos corretamente.
- Fatura de cartão de crédito é reconhecida e recusada por enquanto (terá tratamento próprio na próxima etapa).

## Versão 0.2.2 — Trava de categoria no banco

- O banco recusa uma saída com categoria de entrada (e vice-versa), com mensagem clara no app. Protege a futura importação de extratos.
- Removidas permissões que o app não usa: apagar tabela inteira, gatilhos e escrita na visão de saldos.

## Versão 0.2.1 — Segurança e backup

- **Sair** desconecta só o aparelho atual; os outros continuam conectados.
- **Cadastro de novos usuários desligado** no Supabase (só o titular entra).
- **Backup diário criptografado** do banco, com ensaio automático de restauração. Veja [BACKUP.md](BACKUP.md).
- **Migrações do banco versionadas** em `supabase/migrations`, idênticas às aplicadas no Supabase.

## Versão 0.2.0 — Lançamentos manuais

- **+ Novo lançamento** (em qualquer tela): saída, entrada ou transferência entre contas, com valor, descrição, data, conta, categoria, situação (pago/recebido ou pendente) e observações.
  - O valor aceita o jeito brasileiro: `25,90`, `1.234,56`, `R$ 10`.
  - Na transferência, a categoria some e aparece a conta de destino; ela não conta como entrada nem saída.
  - Erros aparecem em português, no próprio formulário, antes de enviar.
- **Lista do mês**, agrupada por dia (Hoje, Ontem, qui 5 de nov…), com setas para trocar de mês, filtro por conta e por categoria, e busca pela descrição (ignora acentos).
- **Totais** de entradas, saídas e resultado do que está na lista. Pendentes ("a pagar", "a receber") aparecem marcados e não entram nos totais nem no saldo até serem pagos.
- **Editar e excluir:** toque no lançamento; a exclusão pede confirmação.
- **Início** ganhou o resumo do mês atual (entradas, saídas, resultado e o que está pendente).

## Versão 0.1.0 — Base do app

- **Login** com e-mail e senha, só para o titular (não há cadastro aberto). A sessão fica salva no navegador e é renovada sozinha.
- **Início:** saldo total e saldo de cada conta, calculados pelo banco (visão `saldos_contas`).
- **Contas** e **Categorias** (despesas e receitas), lidas do banco.
- Menu lateral no computador e barra inferior no celular.

## Segurança

- **Regras de acesso (RLS)** em todas as tabelas: cada linha só é lida ou alterada pelo seu dono. A visão de saldos roda com as permissões de quem consulta (`security_invoker`).
- **Chave publicável** no `app.js`: ela é feita para ficar no navegador. Chaves secretas (`service_role`, `sb_secret_…`) **nunca** entram neste repositório; o teste de segurança falha se aparecerem.
- **Política de segurança (CSP):** o site só roda scripts dele mesmo e da biblioteca do Supabase no jsDelivr, e só se conecta ao Supabase deste projeto.
- **Integridade (SRI)** na biblioteca do Supabase: uma cópia adulterada no CDN é bloqueada pelo navegador. Para atualizar a biblioteca, troque a versão **e** o `integrity` juntos.
- **Sem HTML montado a partir de texto:** nomes de contas e categorias entram na tela como texto puro, o que evita XSS.

## Testes

```bash
npm test
```

Roda sem rede e sem credenciais: confere a sintaxe do `app.js`, as funções de cálculo e formatação (`tests/logica.cjs`), a lógica dos lançamentos — valores em reais, datas, validação, totais e filtros (`tests/lancamentos.cjs`) — e as regras de segurança do site (`tests/seguranca-site.cjs`). O GitHub roda os mesmos testes a cada envio (workflow **Checkup**).

## Banco de dados

O esquema foi criado pelas migrações `fase1_base_financeira` e `cor_especie_neutra`, aplicadas no projeto Supabase `financeiro-pessoal`:

- `contas`, `categorias` e `lancamentos` (receita, despesa ou transferência), todas com `usuario_id`.
- Chaves estrangeiras compostas impedem que um lançamento aponte para conta ou categoria de outro usuário.
- `saldos_contas` (saldo atual por conta) e `resumo_periodo(inicio, fim)` (saldo anterior, entradas, saídas e pendências).
- Contas e categorias padrão são criadas automaticamente para cada novo usuário.
- `convites` (migração `convites`): sem acesso direto pelo site; só pelas funções `criar_convite`, `listar_convites`, `cancelar_convite` e `sou_administrador`, que conferem o administrador.

## Próximas etapas

1. Cartão de crédito, se usar.
2. Limites por categoria e memória de preferências do assistente.
