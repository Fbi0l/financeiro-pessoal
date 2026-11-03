# financeiro-pessoal

App para registrar, entender e controlar os próprios gastos. É um site estático (HTML, CSS e JavaScript, sem etapa de build) que usa o Supabase para banco de dados, login e regras de acesso. Funciona no computador e no celular.

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

## Próximas etapas

1. Cartão de crédito, se usar.
2. Edição de contas (saldo inicial) e categorias.
3. Análise do mês, limites por categoria e instalação no celular (PWA).
