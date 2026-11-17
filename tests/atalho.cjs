// Lancar pelo celular: tela, tutorial e nomes das funcoes do banco usados pelo app e pelo guia.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PASSOS_TUTORIAL, NOVIDADES } = require('../app.js');
const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const migracao = fs.readdirSync('supabase/migrations').filter(f => f.endsWith('_lancar_pelo_atalho.sql'));
assert.equal(migracao.length, 1, 'migracao do atalho existe');
const sql = fs.readFileSync('supabase/migrations/' + migracao[0], 'utf8');

for (const id of ['atalhoPainel', 'atalhoForm', 'atalhoApelido', 'atalhoCriar', 'atalhoGerada', 'atalhoChave', 'atalhoMensagem', 'atalhoLista',
  'atalhoGuia', 'atalhoUrlLancar', 'atalhoUrlContas', 'atalhoApikey', 'atalhoGuiaMensagem'])
  assert.ok(html.includes(`id="${id}"`), `index.html tem #${id}`);
// Cada botao Copiar aponta para um campo que existe.
for (const [, alvo] of html.matchAll(/data-alvo="([^"]+)"/g)) assert.ok(html.includes(`id="${alvo}"`), `copiar aponta para #${alvo}`);
// O campo do apelido e uma entrada de texto (16px no celular via CSS).
assert.match(fs.readFileSync('styles.css', 'utf8'), /@media \(max-width:760px\)\{\.atalho-novo input\{font-size:16px\}\}/);

// Funcoes chamadas pelo app e enderecos do guia existem na migracao, com as permissoes certas.
for (const f of ['criar_chave_atalho', 'listar_chaves_atalho', 'cancelar_chave_atalho']) {
  assert.ok(app.includes(`db.rpc('${f}'`), `app chama ${f}`);
  assert.match(sql, new RegExp(`create function public\\.${f}\\(`), `banco tem ${f}`);
}
assert.ok(app.includes("'/rest/v1/rpc/atalho_lancar'") && app.includes("'/rest/v1/rpc/atalho_contas'"), 'guia mostra os enderecos');
assert.match(sql, /grant execute on function public\.atalho_contas\(text\), public\.atalho_lancar\(text, text, text, text, text\) to anon, authenticated;/);
assert.match(sql, /grant execute on function public\.criar_chave_atalho\(text\), public\.listar_chaves_atalho\(\), public\.cancelar_chave_atalho\(uuid\) to authenticated;/);
// Toda funcao security definer da migracao tem search_path vazio.
const definers = sql.match(/security definer[^$]*?as \$\$/g) || [];
assert.ok(definers.length >= 5 && definers.every(d => d.includes("set search_path = ''")), 'security definer com search_path vazio');
// Os campos do JSON no guia batem com os parametros da funcao.
for (const p of ['p_chave', 'p_valor', 'p_descricao', 'p_conta']) { assert.ok(html.includes(p), `guia cita ${p}`); assert.ok(sql.includes(p + ' text'), `funcao tem ${p}`); }

// Tutorial explica a funcionalidade e aponta para a tela de Contas.
const passo = PASSOS_TUTORIAL.find(p => /celular/i.test(p.titulo));
assert.ok(passo, 'tutorial tem passo do celular');
assert.equal(passo.pagina, 'contas');
assert.ok(passo.itens.some(i => /Criar chave/.test(i)) && passo.itens.some(i => /Cancele a chave/.test(i)));
// Novidade da versao.
assert.ok(NOVIDADES.some(n => n.id === 'lancar-pelo-celular'));
// Instalar o atalho pronto: link do iCloud (sem chave no link) e botao que copia a chave antes de abrir.
assert.match(app, /const LINK_ATALHO_GASTEI = 'https:\/\/www\.icloud\.com\/shortcuts\/[0-9a-f]{32}';/);
assert.ok(html.includes('id="atalhoInstalar"'), 'botao instalar');
assert.ok(app.includes("$('atalhoInstalar').addEventListener('click', instalarAtalho)"));
const corpo = app.slice(app.indexOf('async function instalarAtalho'), app.indexOf('async function copiarCampo'));
assert.ok(corpo.indexOf('clipboard.writeText') < corpo.indexOf('location.href'), 'copia antes de abrir o link');
assert.ok(passo.itens.some(i => /Adicionar Atalho/.test(i)), 'tutorial explica a instalacao');
assert.ok(passo.itens.some(i => /Toque Atrás/.test(i)) && html.includes('Toque Atrás'), 'dica do Toque Atras no tutorial e no painel');
console.log('Lancar pelo celular aprovado: tela, guia, tutorial e funcoes do banco.');
