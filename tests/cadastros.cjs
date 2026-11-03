// Contas e categorias: leitura do saldo informado, calculo do saldo inicial, validacoes e mensagens de erro.
const assert = require('node:assert/strict');
const A = require('../app.js');

// Saldo informado pela pessoa: aceita zero e negativo (o valor de lancamento nao aceita).
const saldos = { '0': 0, '0,00': 0, '-0': 0, '1.234,56': 1234.56, '-50': -50, '−12,30': -12.3, 'R$ 100': 100, '+7,5': 7.5, ' -1.000,00 ': -1000 };
for (const [t, v] of Object.entries(saldos)) assert.equal(A.lerSaldo(t), v, `lerSaldo(${t})`);
for (const t of ['', 'abc', '--5', '1,2,3', null]) assert.equal(A.lerSaldo(t), null, `recusa ${JSON.stringify(t)}`);

// Saldo inicial que faz o saldo de hoje bater com o banco, sem mexer nos lancamentos.
// Conta com saldo inicial 0 e lancamentos que somam -189,40 (saldo atual -189,40); o banco mostra 1.250,00.
assert.equal(A.saldoInicialPara(1250, -189.4, 0), 1439.4);
// Ja tinha saldo inicial 100 e lancamentos +50 (atual 150); o banco mostra 150: nada muda.
assert.equal(A.saldoInicialPara(150, 150, 100), 100);
// Banco negativo (cheque especial).
assert.equal(A.saldoInicialPara(-80.1, 20, 0), -100.1);
// Centavos exatos (0,1 + 0,2).
assert.equal(A.saldoInicialPara(0.3, 0.2, 0.1), 0.2);
// Conferencia: saldo inicial calculado + movimentos = saldo informado.
for (const [hoje, atual, inicial] of [[1250, -189.4, 0], [33.33, 1000.01, 999.99], [-5, 0, 0]]) {
  const novo = A.saldoInicialPara(hoje, atual, inicial);
  assert.equal(Math.round((novo + (atual - inicial)) * 100) / 100, hoje);
}

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
console.log('Cadastros aprovados: saldo informado, saldo inicial calculado, validacoes, cores e mensagens.');
