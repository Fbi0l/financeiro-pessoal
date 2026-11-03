# financeiro-pessoal

App para registrar, entender e controlar os próprios gastos. É um site estático (HTML, CSS e JavaScript, sem etapa de build) que usa o Supabase para banco de dados, login e regras de acesso. Funciona no computador e no celular.

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

1. Importação de extrato (CSV ou OFX).
2. Cartão de crédito, se usar.
3. Análise do mês, limites por categoria e instalação no celular (PWA).
