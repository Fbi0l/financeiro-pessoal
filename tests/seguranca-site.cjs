// Seguranca do site, sem rede: politica CSP restrita, scripts externos com integridade (SRI),
// nenhum script ou estilo inline, e nenhuma chave secreta no codigo.
const fs = require('fs'), assert = require('node:assert/strict');
const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');

// Todo script externo: versao exata, integridade sha384 e crossorigin.
const externos = [...html.matchAll(/<script\s[^>]*src="(https?:[^"]+)"[^>]*>/g)];
assert.ok(externos.length >= 1, 'scripts externos encontrados');
for (const [tag, src] of externos) {
  assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]{64}"/, `sem integridade em ${src}`);
  assert.match(tag, /crossorigin="anonymous"/, `sem crossorigin em ${src}`);
  assert.match(src, /@\d+\.\d+\.\d+\//, `versao exata em ${src}`);
}
// Nada inline (a politica nao permite).
assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), 'script inline');
assert.ok(!/\son[a-z]+=/i.test(html), 'atributo on* inline');
assert.ok(!/\sstyle=/i.test(html), 'atributo style inline');
assert.ok(!/<style/i.test(html), 'bloco <style> inline');
for (const arquivo of ['app.js', 'importar.js'])
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(fs.readFileSync(arquivo, 'utf8')), `${arquivo} monta HTML ou codigo a partir de texto (risco de XSS)`);
// Todo script do proprio site carregado pela pagina existe e e verificado aqui.
const locais = [...html.matchAll(/<script\s[^>]*src="([^":]+?)(\?[^"]*)?"/g)].map(m => m[1]);
assert.deepEqual(locais.sort(), ['app.js', 'importar.js']);

// Politica CSP.
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
assert.ok(csp, 'politica CSP ausente');
const diretiva = nome => ((csp.match(new RegExp(`(?:^|;\\s*)${nome} ([^;]+)`)) || [])[1] || '').trim().split(/\s+/).sort();
assert.deepEqual(diretiva('script-src'), ["'self'", 'https://cdn.jsdelivr.net'].sort());
assert.deepEqual(diretiva('style-src'), ["'self'"]);
assert.deepEqual(diretiva('object-src'), ["'none'"]);
assert.deepEqual(diretiva('base-uri'), ["'self'"]);
assert.deepEqual(diretiva('frame-src'), ["'none'"]);

// O site so conversa com o Supabase do proprio projeto.
const url = (app.match(/SUPABASE_URL = '([^']+)'/) || [])[1];
assert.match(url, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
const host = url.replace('https://', '');
assert.deepEqual(diretiva('connect-src'), ["'self'", `https://${host}`, `wss://${host}`].sort());

// Somente chave publicavel: nunca service_role nem chave secreta.
assert.match(app, /SUPABASE_KEY = 'sb_publishable_[A-Za-z0-9_-]+'/, 'chave publicavel');
for (const arquivo of ['index.html', 'app.js', 'importar.js', 'styles.css']) {
  const t = fs.readFileSync(arquivo, 'utf8');
  assert.ok(!/sb_secret_|service_role/.test(t), `${arquivo}: possivel chave secreta`);
}
// App instalavel: manifesto valido, icones existem e o service worker nunca guarda dados do Supabase.
const manifesto = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
assert.equal(manifesto.display, 'standalone'); assert.equal(manifesto.scope, '/financeiro-pessoal/');
assert.ok(manifesto.start_url.startsWith(manifesto.scope));
for (const i of manifesto.icons) assert.ok(fs.existsSync(i.src), `icone ${i.src}`);
assert.ok(manifesto.icons.some(i => i.sizes === '192x192') && manifesto.icons.some(i => i.sizes === '512x512') && manifesto.icons.some(i => i.purpose === 'maskable'));
assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/); assert.ok(fs.existsSync('assets/apple-touch-icon.png'));
const sw = fs.readFileSync('sw.js', 'utf8');
const versoesHtml = [...new Set([...html.matchAll(/\?v=(\d+\.\d+\.\d+)/g)].map(m => m[1]))];
assert.equal(versoesHtml.length, 1, 'uma so versao nos arquivos da pagina');
const versoesVisiveis = [...new Set([...html.matchAll(/Versão (\d+\.\d+\.\d+)/g)].map(m => m[1]))];
assert.deepEqual(versoesVisiveis, versoesHtml, 'versao mostrada (login, convite, menu e rodape) igual a dos arquivos');
assert.ok([...html.matchAll(/Versão \d/g)].length >= 4, 'versao aparece no login, no convite, no menu e no rodape do app');
for (const arq of ['app.js', 'importar.js', 'styles.css']) assert.ok(sw.includes(`./${arq}?v=${versoesHtml[0]}`), `sw.js guarda ${arq} na versao da pagina`);
assert.ok(sw.includes(`'financeiro-v${versoesHtml[0]}'`), 'nome do cache acompanha a versao');
assert.ok(!/supabase\.co/.test(sw), 'service worker nao menciona o Supabase');
assert.match(sw, /const PERMITIDOS = \[self\.location\.origin, 'https:\/\/cdn\.jsdelivr\.net'\]/);
assert.match(sw, /req\.method !== 'GET' \|\| !PERMITIDOS\.includes\(url\.origin\)\) return;/, 'so GET do proprio site e do CDN');
console.log('Site aprovado: CSP restrita, integridade dos scripts externos, nada inline, so chave publicavel e app instalavel seguro.');
