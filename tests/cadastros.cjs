// Contas e categorias: leitura do saldo informado, calculo do saldo inicial, validacoes e mensagens de erro.
const assert = require('node:assert/strict');
const A = require('../app.js');

// Saldo informado pela pessoa: aceita zero e negativo (o valor de lancamento nao aceita).
const saldos = { '0': 0, '0,00': 0, '-0': 0, '1.234,56': 1234.56, '-50': -50, '−12,30': -12.3, 'R$ 100': 100, '+7,5': 7.5, ' -1.000,00 ': -1000 };
for (const [t, v] of Object.entries(saldos)) assert.equal(A.lerSaldo(t), v, `lerSaldo(${t})`);
for (const t of ['', 'abc', '--5', '1,2,3', null]) assert.equal(A.lerSaldo(t), null, `recusa ${JSON.stringify(t)}`);

// Acertar o saldo com o do banco: a diferenca vira um lancamento visivel "Ajuste de saldo" (o saldo inicial nao muda).
const cats = [
  { id: 'od', nome: 'Outras despesas', tipo: 'despesa' }, { id: 'or', nome: 'Outras receitas', tipo: 'receita' },
  { id: 'al', nome: 'Alimentação', tipo: 'despesa' }
];
// App mostra 329,85, banco mostra 160,02: saida de 169,83 em "Outras despesas".
let aj = A.ajusteDeSaldo(160.02, 329.85, 'nu', cats, '2026-11-17');
assert.deepEqual({ tipo: aj.tipo, valor: aj.valor, cat: aj.categoria_id, data: aj.data, conta: aj.conta_id, pago: aj.pago, destino: aj.conta_destino_id, desc: aj.descricao },
  { tipo: 'despesa', valor: 169.83, cat: 'od', data: '2026-11-17', conta: 'nu', pago: true, destino: null, desc: 'Ajuste de saldo' });
assert.match(aj.observacoes, /329,85/); assert.match(aj.observacoes, /160,02/);
// Banco com mais dinheiro: entrada em "Outras receitas".
aj = A.ajusteDeSaldo(1000, 800, 'pj', cats, '2026-11-17');
assert.equal(aj.tipo, 'receita'); assert.equal(aj.valor, 200); assert.equal(aj.categoria_id, 'or');
// Sem diferenca (inclusive por centavos de ponto flutuante): nenhum ajuste.
assert.equal(A.ajusteDeSaldo(150, 150, 'x', cats, '2026-11-17'), null);
assert.equal(A.ajusteDeSaldo(0.3, 0.1 + 0.2, 'x', cats, '2026-11-17'), null);
// Centavos exatos e saldo negativo (cheque especial).
assert.equal(A.ajusteDeSaldo(-80.1, 20, 'x', cats, 'd').valor, 100.1);
assert.equal(A.ajusteDeSaldo(0.3, 0.2, 'x', cats, 'd').valor, 0.1);
// Categoria arquivada ou inexistente: ajuste sem categoria (o banco aceita).
assert.equal(A.ajusteDeSaldo(1, 2, 'x', [{ id: 'od', nome: 'Outras despesas', tipo: 'despesa', arquivada: true }], 'd').categoria_id, null);
assert.equal(A.ajusteDeSaldo(1, 2, 'x', null, 'd').categoria_id, null);
// Nome sem acento e com espacos tambem serve.
assert.equal(A.ajusteDeSaldo(3, 2, 'x', [{ id: 'k', nome: ' outras RECEITAS ', tipo: 'receita' }], 'd').categoria_id, 'k');
// O ajuste passa na mesma validacao de um lancamento comum.
assert.equal(A.validarLancamento(A.ajusteDeSaldo(160.02, 329.85, 'nu', cats, '2026-11-17')), null);
// Conferencia: saldo do app + efeito do ajuste = saldo informado.
for (const [hoje, atual] of [[1250, -189.4], [33.33, 1000.01], [-5, 0], [0.01, 0]]) {
  const a = A.ajusteDeSaldo(hoje, atual, 'x', cats, 'd');
  assert.equal(Math.round((atual + (a.tipo === 'receita' ? a.valor : -a.valor)) * 100) / 100, hoje);
}
// O app nao recalcula mais o saldo inicial escondido.
assert.equal(A.saldoInicialPara, undefined);

// Validacoes
const conta = { nome: 'Nubank', tipo: 'corrente', cor: '#36418a', saldo_inicial: 0 };
assert.equal(A.validarConta(conta), null);
assert.match(A.validarConta({ ...conta, nome: '  ' }), /nome/);
assert.match(A.validarConta({ ...conta, nome: 'x'.repeat(61) }), /60/);
assert.match(A.validarConta({ ...conta, tipo: 'cartao' }), /tipo/);
assert.match(A.validarConta({ ...conta, cor: 'red' }), /cor/);
assert.match(A.validarConta({ ...conta, saldo_inicial: null }), /saldo/);
assert.equal(A.validarConta({ ...conta, saldo_inicial: -500 }), null, 'saldo negativo e valido');
const cat = { nome: 'Pets', tipo: 'despesa', cor: '#e8590c' };
assert.equal(A.validarCategoria(cat), null);
assert.match(A.validarCategoria({ ...cat, nome: '' }), /nome/);
assert.match(A.validarCategoria({ ...cat, nome: 'x'.repeat(41) }), /40/);
assert.match(A.validarCategoria({ ...cat, tipo: 'transferencia' }), /saída ou de entrada/);
assert.match(A.validarCategoria({ ...cat, cor: '#fff' }), /cor/);

// Paleta: cores validas para o banco (#RRGGBB) e sem repetir.
assert.ok(A.CORES.length >= 10 && A.CORES.every(c => /^#[0-9a-f]{6}$/i.test(c)) && new Set(A.CORES).size === A.CORES.length);

// Mensagens do banco
assert.match(A.mensagemErroCadastro({ code: '23505', message: 'dup' }, 'conta'), /Já existe uma conta com esse nome/);
assert.match(A.mensagemErroCadastro({ code: '23505', message: 'dup' }, 'categoria'), /categoria desse tipo/);
assert.match(A.mensagemErroCadastro({ code: '23503', message: 'fk' }, 'conta'), /tem lançamentos\. Arquive/);
assert.match(A.mensagemErroCadastro({ message: 'Failed to fetch' }, 'conta'), /conexão/);
console.log('Cadastros aprovados: saldo informado, ajuste de saldo visivel, validacoes, cores e mensagens.');
