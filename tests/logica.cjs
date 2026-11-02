// Funcoes puras do app.js: formatacao de moeda, soma de saldos, cores e mensagens de login.
const assert = require('node:assert/strict');
const { formatarMoeda, somarSaldos, corSegura, rotuloTipoConta, mensagemErroLogin } = require('../app.js');
const limpa = s => s.replace(/\s/g, ' ');

assert.equal(limpa(formatarMoeda(1234.5)), 'R$ 1.234,50');
assert.equal(limpa(formatarMoeda(-10)), '-R$ 10,00');
assert.equal(limpa(formatarMoeda('abc')), 'R$ 0,00');
assert.equal(limpa(formatarMoeda(null)), 'R$ 0,00');

// Soma em centavos: 0,1 + 0,2 da exatamente 0,3; contas arquivadas ficam de fora.
assert.equal(somarSaldos([{ saldo_atual: 0.1 }, { saldo_atual: 0.2 }]), 0.3);
assert.equal(somarSaldos([{ saldo_atual: 100 }, { saldo_atual: 50, arquivada: true }, { saldo_atual: '-20.5' }]), 79.5);
assert.equal(somarSaldos([]), 0);
assert.equal(somarSaldos(null), 0);

assert.equal(corSegura('#1d6b4f'), '#1d6b4f');
for (const ruim of ['red', 'url(x)', '#fff', '#12345g', '', null, '#123456;background:red'])
  assert.equal(corSegura(ruim), '#6d7b8f', `cor recusada: ${ruim}`);

assert.equal(rotuloTipoConta('poupanca'), 'Poupança');
assert.equal(rotuloTipoConta('xyz'), 'Outro');

assert.equal(mensagemErroLogin({ message: 'Invalid login credentials' }), 'E-mail ou senha incorretos.');
assert.equal(mensagemErroLogin({ status: 429, message: 'x' }), 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
assert.equal(mensagemErroLogin({ message: 'Failed to fetch' }), 'Sem conexão com o servidor. Verifique sua internet.');
assert.equal(mensagemErroLogin(undefined), 'Não foi possível entrar. Tente novamente.');
console.log('Logica aprovada: moeda, saldos, cores e mensagens de login.');
