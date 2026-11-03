# Backup automático criptografado

Todo dia às **06h (Belém)**, o GitHub faz uma cópia do banco do app, confere se ela pode ser lida por inteiro, **criptografa** com a sua chave e guarda por **30 dias** em *Actions → Backup criptografado*. A conexão diária também evita que o Supabase pause o projeto gratuito por falta de uso.

São dois arquivos por dia, os dois criptografados:

- `financeiro_dados_…dump.age`: contas, categorias, lançamentos, regras de acesso, gatilhos e funções (esquemas `public` e `privado`).
- `financeiro_auth_…dump.age`: sua conta de login (e-mail e hash da senha), para recriar o acesso num projeto novo.

Ficam de fora as configurações do login no painel do Supabase e o gatilho que cria as contas padrão de usuários novos; esse gatilho está em `supabase/migrations`.

O workflow **Teste do backup** ensaia tudo com um PostgreSQL de teste e dados fictícios: aplica as migrações reais, faz o backup, restaura e compara origem e destino.

## Configurar (uma vez)

### 1. Chave de criptografia

Se você já tem a chave do Inventário em `BackupsInventario\chave-privada-backup-age.txt`, pode usar a mesma. Mostre a parte pública no PowerShell:

```powershell
age-keygen -y "$HOME\BackupsInventario\chave-privada-backup-age.txt"
```

A linha que começa com `age1…` é a chave pública. A chave privada **nunca** vai para o GitHub nem para o chat.

### 2. Dados de conexão

No Supabase, abra o projeto **financeiro-pessoal** → botão **Connect** → **Session pooler**. Anote o host, a porta e o usuário.

Se não souber a senha do banco, gere uma nova em *Project Settings → Database → Reset database password*. O app não usa essa senha, então trocá-la não afeta nada.

### 3. Cadastrar no GitHub

Em *Settings → Secrets and variables → Actions* do repositório:

| Aba | Nome | Valor |
|---|---|---|
| Variables | `SUPABASE_DB_HOST` | Host do *Session pooler* |
| Variables | `SUPABASE_DB_PORT` | `5432` |
| Variables | `SUPABASE_DB_USER` | Usuário do *Session pooler* (`postgres.ruphlnabikvnadlmeisg`) |
| Variables | `BACKUP_AGE_RECIPIENT` | Chave pública `age1…` |
| Variables | `BACKUP_ENABLED` | `true` |
| **Secrets** | `SUPABASE_DB_PASSWORD` | Senha do banco |

### 4. Primeiro teste

*Actions → Backup criptografado → Run workflow*. Ao terminar verde, baixe o artefato e teste a abertura:

```powershell
age --decrypt -i "$HOME\BackupsInventario\chave-privada-backup-age.txt" `
  -o "$HOME\BackupsInventario\financeiro-teste.dump" "$HOME\Downloads\financeiro_dados_DATA.dump.age"
```

O arquivo aberto tem seus dados financeiros: apague-o depois do teste e nunca o publique.

## Restaurar (em caso de perda)

1. Crie um projeto Supabase novo. **Não** aplique as migrações: o backup já recria tabelas, regras de acesso, permissões, gatilhos e funções.
2. Restaure primeiro as contas de login e depois os dados, pulando só o item `SCHEMA public`, que já existe:

```bash
pg_restore --no-owner --no-acl -d "$URL_DO_BANCO" financeiro_auth.dump
pg_restore -l financeiro_dados.dump | grep -vE ' SCHEMA - public ' > lista.txt
pg_restore --no-owner --exit-on-error -L lista.txt -d "$URL_DO_BANCO" financeiro_dados.dump
```

3. Opcional: se quiser que contas novas recebam as contas e categorias padrão, rode o trecho final de `supabase/migrations/20261101033035_cor_especie_neutra.sql` (a função) e o `create trigger ao_criar_usuario` da primeira migração.
4. Desligue o cadastro de novos usuários no painel (*Authentication → Sign In / Providers*).
5. Troque o endereço e a chave publicável no `app.js`, e o endereço na política de segurança do `index.html`.

O procedimento exato é o do teste automático `tests/backup-restauracao.sh`.
