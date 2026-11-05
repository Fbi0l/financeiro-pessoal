// Modo escuro e avisos de novidade (sem navegador): regras do tema, lista de novidades e estrutura da pagina.
const fs = require('fs'), assert = require('node:assert/strict');
const { resolverTema, COR_BARRA } = require('../tema.js');
const { NOVIDADES, novidadesPendentes, juntarVistas, PASSOS_TUTORIAL } = require('../app.js');

// Tema: escolha salva vence; sem escolha (ou escolha estranha), segue o aparelho.
assert.equal(resolverTema('escuro', false), 'escuro');
assert.equal(resolverTema('claro', true), 'claro');
assert.equal(resolverTema(null, true), 'escuro', 'aparelho escuro');
assert.equal(resolverTema(null, false), 'claro', 'aparelho claro');
for (const ruim of ['', 'dark', 'ESCURO', undefined, '{"x":1}']) assert.equal(resolverTema(ruim, false), 'claro', `escolha invalida: ${ruim}`);
assert.match(COR_BARRA.claro, /^#[0-9a-f]{6}$/); assert.match(COR_BARRA.escuro, /^#[0-9a-f]{6}$/);

// Novidades: ids unicos, versao, texto e no maximo uma acao conhecida.
const ids = NOVIDADES.map(n => n.id);
assert.ok(NOVIDADES.length >= 1);
assert.equal(new Set(ids).size, ids.length, 'ids de novidade repetidos');
for (const n of NOVIDADES) {
  assert.match(n.id, /^[a-z0-9-]+$/); assert.match(n.versao, /^\d+\.\d+\.\d+$/);
  assert.ok(n.titulo && n.texto && n.icone, `novidade ${n.id} completa`);
  if (n.acao) assert.ok(['tema-escuro'].includes(n.acao.tipo) && n.acao.rotulo, `acao de ${n.id} conhecida`);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.equal(NOVIDADES[0].versao, pkg.version, 'a novidade mais recente e da versao atual');
assert.ok(NOVIDADES.some(n => n.id === 'modo-escuro'), 'aviso do modo escuro existe');

// Cada aviso aparece uma vez: some quando visto no perfil OU neste aparelho.
const lista = [{ id: 'b' }, { id: 'a' }];
assert.deepEqual(novidadesPendentes(lista, [], []).map(n => n.id), ['b', 'a'], 'mais nova primeiro');
assert.deepEqual(novidadesPendentes(lista, ['b'], null).map(n => n.id), ['a'], 'vista em outro aparelho');
assert.deepEqual(novidadesPendentes(lista, undefined, ['a', 'b']), [], 'vista neste aparelho');
assert.deepEqual(novidadesPendentes(lista, 'b', { a: 1 }).map(n => n.id), ['b', 'a'], 'dados estranhos no perfil nao escondem nada');
assert.deepEqual(juntarVistas(lista, ['a'], ['a', 'velha'], null, ['b']), ['a', 'b'], 'sem repetir e sem ids que nao existem mais');

// Pagina: botao do tema, espaco do aviso, tema carregado antes do CSS e sem defer (para nao piscar).
const html = fs.readFileSync('index.html', 'utf8');
for (const id of ['temaBtn', 'novidadeAviso', 'novidadeIcone', 'novidadeTitulo', 'novidadeTexto', 'novidadeAcao', 'novidadeFechar'])
  assert.ok(html.includes(`id="${id}"`), `index.html tem #${id}`);
const tagTema = (html.match(/<script src="tema\.js\?v=[^"]+"[^>]*>/) || [])[0];
assert.ok(tagTema && !/defer|async/.test(tagTema), 'tema.js carrega sem defer');
assert.ok(html.indexOf('tema.js') < html.indexOf('styles.css') && html.indexOf('name="theme-color"') < html.indexOf('tema.js'), 'tema.js depois da cor da barra e antes do CSS');

// CSS: o modo escuro troca as cores base e nada de branco fixo sobrou em fundo de campo.
const css = fs.readFileSync('styles.css', 'utf8');
const bloco = (css.match(/:root\[data-tema="escuro"\]\{([^}]+)\}/) || [])[1] || '';
for (const v of ['--bg', '--surface', '--ink', '--muted', '--line', '--field', '--field-line', '--label', '--hover', '--pos', '--danger'])
  assert.match(bloco, new RegExp(`${v}:`), `modo escuro define ${v}`);
assert.match(bloco, /color-scheme:dark/);
assert.ok(!/background:#fff\b/.test(css), 'fundo branco fixo no CSS (use var(--field) ou var(--surface))');
assert.ok(PASSOS_TUTORIAL.some(p => p.itens.some(t => t.includes('modo escuro'))), 'guia menciona o modo escuro');
console.log('Modo escuro e avisos de novidade aprovados.');
