// Funcao de cadastro por convite, com banco e Auth simulados (sem rede).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tratarCadastro, validarSenha, senhaVazada, hashCodigo } from '../supabase/functions/registrar-convite/cadastro.js';

const sha = s => createHash('sha256').update(s).digest('hex');
const CODIGO = 'A'.repeat(20) + '_-' + 'b9'.repeat(10) + 'x'; // 43 caracteres
assert.equal(CODIGO.length, 43);
assert.equal(await hashCodigo(CODIGO), sha(CODIGO), 'hash igual ao do banco (sha256 hex)');

// Senhas
assert.match(validarSenha('curta'), /10 caracteres/);
assert.match(validarSenha('a'.repeat(73)), /72/);
assert.match(validarSenha('aaaaaaaaaaaa'), /previsível/);
assert.match(validarSenha('mariana2026!!', 'mariana@x.com'), /e-mail/);
assert.equal(validarSenha('cavalo-azul-bateria', 'ana@x.com'), null);

// Senha vazada (k-anonimato): so 5 caracteres do SHA-1 saem; falha do servico nao trava.
const sha1 = s => createHash('sha1').update(s).digest('hex').toUpperCase();
let pedidoHibp;
const hibp = async url => { pedidoHibp = url; const h = sha1('senha-muito-vazada'); return { ok: true, text: async () => `00000000000000000000000000000000000:0\n${h.slice(5)}:1234\n` }; };
assert.equal(await senhaVazada('senha-muito-vazada', hibp), true);
assert.equal(pedidoHibp, `https://api.pwnedpasswords.com/range/${sha1('senha-muito-vazada').slice(0, 5)}`);
assert.equal(await senhaVazada('outra-senha-qualquer', hibp), false);
assert.equal(await senhaVazada('x', async () => { throw new Error('offline'); }), false);
const hibpLimpo = async () => ({ ok: true, text: async () => '' });

// Banco e Auth simulados
function ambiente({ convites, usuarios = ['ja@existe.com'], falharCriacao = false, atraso = 0 }) {
  const criados = [];
  const admin = {
    auth: { admin: { createUser: async ({ email, password, email_confirm }) => {
      await new Promise(r => setTimeout(r, atraso));
      assert.equal(email_confirm, true);
      if (falharCriacao || usuarios.includes(email)) return { data: null, error: { message: 'A user with this email address has already been registered' } };
      usuarios.push(email); const user = { id: 'novo-' + criados.length }; criados.push({ email, password, user }); return { data: { user }, error: null };
    } } },
    from(t) {
      assert.equal(t, 'convites');
      let filtros = [], acao = 'select', valores = null;
      const passa = c => filtros.every(([op, col, v]) => op === 'eq' ? c[col] === v : op === 'is' ? c[col] === v : op === 'gt' ? c[col] > v : true);
      const q = {
        select() { return q; }, update(v) { acao = 'update'; valores = v; return q; },
        eq(c, v) { filtros.push(['eq', c, v]); return q; }, is(c, v) { filtros.push(['is', c, v]); return q; }, gt(c, v) { filtros.push(['gt', c, v]); return q; },
        maybeSingle() { const r = convites.filter(passa); return Promise.resolve({ data: r[0] ? { rotulo: r[0].rotulo, expira_em: r[0].expira_em } : null, error: null }); },
        then(res, rej) {
          // update ... returning e atomico (como no Postgres): filtra e altera no mesmo passo.
          const alvo = convites.filter(passa);
          if (acao === 'update') alvo.forEach(c => Object.assign(c, valores));
          return Promise.resolve({ data: alvo.map(c => ({ id: c.id })), error: null }).then(res, rej);
        }
      };
      return q;
    }
  };
  return { admin, criados };
}
const futuro = new Date(Date.now() + 864e5).toISOString(), passado = new Date(Date.now() - 1000).toISOString();
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service' };
const pedir = (corpo, origem = 'https://fbi0l.github.io', bruto) => new Request('https://x/functions/v1/registrar-convite', { method: 'POST', headers: { origin: origem, 'content-type': 'application/json' }, body: bruto ?? JSON.stringify(corpo) });
async function rodar(req, amb, fetchFn = hibpLimpo) {
  let chave;
  const r = await tratarCadastro(req, { env: ENV, fetchFn, criarCliente: (u, k) => { chave = k; return amb.admin; } });
  return { status: r.status, corpo: r.status === 204 ? null : await r.json(), cab: r.headers, chave };
}
const novoConvite = (extra = {}) => ({ id: 'c1', rotulo: 'Ana', codigo_hash: sha(CODIGO), usado_em: null, cancelado_em: null, expira_em: futuro, usado_por: null, ...extra });

// Entrada e CORS
let amb = ambiente({ convites: [novoConvite()] });
assert.equal((await tratarCadastro(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'https://fbi0l.github.io' } }), { env: ENV, criarCliente: () => amb.admin })).headers.get('access-control-allow-origin'), 'https://fbi0l.github.io');
assert.equal((await rodar(pedir({ acao: 'verificar', codigo: CODIGO }, 'https://malicioso.com'), amb)).status, 403);
assert.equal((await rodar(pedir(null, undefined, '{'), amb)).status, 400);
assert.equal((await rodar(pedir(null, undefined, '{"a":"' + 'x'.repeat(5000) + '"}'), amb)).status, 413);
for (const ruim of ['', 'curto', CODIGO + 'a', CODIGO.slice(1) + '!', "' or 1=1 --" + 'x'.repeat(32)])
  assert.equal((await rodar(pedir({ acao: 'verificar', codigo: ruim }), amb)).corpo.codigo_erro, 'invalido', `codigo recusado: ${ruim}`);

// Verificar
let v = await rodar(pedir({ acao: 'verificar', codigo: CODIGO }), amb);
assert.deepEqual([v.status, v.corpo.valido, v.corpo.rotulo, v.chave], [200, true, 'Ana', 'service']);
assert.equal((await rodar(pedir({ acao: 'verificar', codigo: CODIGO.replace('A', 'B') }), amb)).status, 410, 'codigo inexistente');
for (const extra of [{ usado_em: passado }, { cancelado_em: passado }, { expira_em: passado }])
  assert.equal((await rodar(pedir({ acao: 'verificar', codigo: CODIGO }), ambiente({ convites: [novoConvite(extra)] }))).corpo.codigo_erro, 'expirado', JSON.stringify(extra));

// Cadastrar: validacoes antes de tocar no convite
const base = { acao: 'cadastrar', codigo: CODIGO, email: ' Ana@Exemplo.com ', senha: 'cavalo-azul-bateria' };
for (const [campo, valor, re] of [['email', 'sem-arroba', /e-mail válido/], ['senha', 'curta', /10 caracteres/]]) {
  const r = await rodar(pedir({ ...base, [campo]: valor }), amb);
  assert.deepEqual([r.status, re.test(r.corpo.erro)], [400, true]);
}
let r = await rodar(pedir({ ...base, senha: 'senha-muito-vazada' }), amb, hibp);
assert.match(r.corpo.erro, /vazamentos/); assert.equal(amb.criados.length, 0, "senha vazada nao cria conta");

// Sucesso
amb = ambiente({ convites: [novoConvite()] });
r = await rodar(pedir(base), amb);
assert.deepEqual([r.status, r.corpo.ok], [201, true]);
assert.deepEqual(amb.criados.map(c => [c.email, c.password]), [['ana@exemplo.com', 'cavalo-azul-bateria']], 'e-mail normalizado');
// Convite marcado como usado e vinculado; nao serve de novo.
r = await rodar(pedir({ ...base, email: 'outra@x.com' }), amb);
assert.deepEqual([r.status, r.corpo.codigo_erro, amb.criados.length], [410, 'expirado', 1]);

// E-mail ja existente: resposta generica e convite devolvido (pode tentar com outro e-mail).
amb = ambiente({ convites: [novoConvite()] });
r = await rodar(pedir({ ...base, email: 'ja@existe.com' }), amb);
assert.equal(r.status, 400); assert.ok(!/existe|registrad|cadastrad/i.test(r.corpo.erro), 'nao revela que o e-mail existe');
r = await rodar(pedir(base), amb);
assert.equal(r.status, 201, 'convite foi devolvido apos a falha');

// Dois cadastros ao mesmo tempo com o mesmo link: so um passa.
amb = ambiente({ convites: [novoConvite()], atraso: 30 });
const [a, b] = await Promise.all([rodar(pedir({ ...base, email: 'um@x.com' }), amb), rodar(pedir({ ...base, email: 'dois@x.com' }), amb)]);
assert.deepEqual([a.status, b.status].sort(), [201, 410]); assert.equal(amb.criados.length, 1);

assert.equal((await rodar(pedir({ acao: 'apagar', codigo: CODIGO }), amb)).status, 400);
console.log('Cadastro por convite aprovado: codigo, CORS, senha (inclusive vazada), uso unico, corrida, e-mail sem revelar e convite devolvido em falha.');
