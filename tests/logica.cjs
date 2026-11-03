// Funcoes puras do app.js: formatacao de moeda, soma de saldos, cores e mensagens de login.
const assert = require('node:assert/strict');
const { formatarMoeda, somarSaldos, corSegura, rotuloTipoConta, mensagemErroLogin, textoSimples, codigoDoLink, linkConvite, expirouPorInatividade, INATIVIDADE_MS } = require('../app.js');
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
// Texto da IA exibido como texto puro (sem simbolos de Markdown soltos).
assert.equal(textoSimples('Você gastou **R$ 87,40** com Uber.'), 'Você gastou R$ 87,40 com Uber.');
assert.equal(textoSimples('## Resumo\n* item um\n* item *dois*\n\n\n\nfim `x`'), 'Resumo\n- item um\n- item dois\n\nfim x');
assert.equal(textoSimples('2 * 3 = 6'), '2 * 3 = 6', 'asterisco de conta fica');
assert.equal(textoSimples(null), '');
assert.equal(textoSimples('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'continua texto (exibido com textContent)');
// Link de convite: so codigos no formato certo sao aceitos; o link sai sem restos do endereco atual.
const COD = 'Mz_8yaX_GmVI_JUiP_9-3DMYTZu0hAym30Qxs0yo0-A';
assert.equal(codigoDoLink('?convite=' + COD), COD);
assert.equal(codigoDoLink('?x=1&convite=' + COD), COD);
for (const ruim of ['', '?convite=', '?convite=curto', '?convite=' + COD + 'a', '?convite=' + COD.slice(1) + '%3C', '?outro=' + COD]) assert.equal(codigoDoLink(ruim), null, ruim);
assert.equal(linkConvite('https://fbi0l.github.io/financeiro-pessoal/', COD), 'https://fbi0l.github.io/financeiro-pessoal/?convite=' + COD);
assert.equal(linkConvite('https://fbi0l.github.io/financeiro-pessoal/?convite=velho#inicio', COD), 'https://fbi0l.github.io/financeiro-pessoal/?convite=' + COD);
// Saida por inatividade: 30 minutos; sem registro de atividade, nao derruba ninguem.
assert.equal(INATIVIDADE_MS, 30 * 60 * 1000);
assert.equal(expirouPorInatividade(String(1e12), 1e12 + INATIVIDADE_MS), false, 'no limite ainda vale');
assert.equal(expirouPorInatividade(String(1e12), 1e12 + INATIVIDADE_MS + 1), true);
for (const v of [null, '', 'abc', '0', undefined]) assert.equal(expirouPorInatividade(v, 1e12), false, `sem registro: ${v}`);

console.log('Logica aprovada: moeda, saldos, cores e mensagens de login.');
