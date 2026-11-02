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
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app), 'app.js monta HTML a partir de texto (risco de XSS)');

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
for (const arquivo of ['index.html', 'app.js', 'styles.css']) {
  const t = fs.readFileSync(arquivo, 'utf8');
  assert.ok(!/sb_secret_|service_role/.test(t), `${arquivo}: possivel chave secreta`);
}
console.log('Site aprovado: CSP restrita, integridade dos scripts externos, nada inline e so chave publicavel.');
