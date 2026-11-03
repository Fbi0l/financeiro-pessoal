// Logica dos lancamentos: leitura de valores em reais, datas do mes, validacao, totais e filtros.
const assert = require('node:assert/strict');
const L = require('../app.js');

// Valores digitados no jeito brasileiro (e alguns jeitos comuns de errar).
const valores = {
  '25,90': 25.9, '1.234,56': 1234.56, '1234,5': 1234.5, 'R$ 10': 10, '  12  ': 12, '12.50': 12.5, '0,01': 0.01,
  '1.234': 1234, '1.234.567,89': 1234567.89, '10,': 10, '7.5': 7.5, '999999999999,99': 999999999999.99
};
for (const [texto, esperado] of Object.entries(valores)) assert.equal(L.lerValor(texto), esperado, `lerValor(${texto})`);
for (const ruim of ['', '0', '0,00', '-5', 'abc', '1,2,3', '12,345', '1.23.4', '12.345.6', '1e5', '10 reais', '1000000000000', null, undefined])
  assert.equal(L.lerValor(ruim), null, `recusa ${JSON.stringify(ruim)}`);
assert.equal(L.valorParaCampo(1234.5), '1.234,50');
assert.equal(L.lerValor(L.valorParaCampo(1234.5)), 1234.5, 'ida e volta do campo de valor');

// Datas: mes inteiro, ano bissexto, virada de ano, data local (sem cair no dia seguinte por causa do UTC).
assert.deepEqual(L.intervaloMes(2026, 11), { inicio: '2026-11-01', fim: '2026-11-30' });
assert.deepEqual(L.intervaloMes(2028, 2), { inicio: '2028-02-01', fim: '2028-02-29' });
assert.deepEqual(L.intervaloMes(2026, 2), { inicio: '2026-02-01', fim: '2026-02-28' });
assert.deepEqual(L.somarMes(2026, 1, -1), { ano: 2025, mes: 12 });
assert.deepEqual(L.somarMes(2026, 12, 1), { ano: 2027, mes: 1 });
assert.deepEqual(L.somarMes(2026, 11, -23), { ano: 2024, mes: 12 });
assert.equal(L.rotuloMes(2026, 3), 'Março de 2026');
assert.equal(L.hojeISO(new Date(2026, 10, 2, 23, 50)), '2026-11-02', '23h50 continua sendo hoje');
assert.equal(L.dataValida('2026-02-30'), false);
assert.equal(L.dataValida('2028-02-29'), true);
assert.equal(L.dataValida('02/11/2026'), false);
assert.equal(L.rotuloDia('2026-11-02', '2026-11-02'), 'Hoje');
assert.equal(L.rotuloDia('2026-10-31', '2026-11-01'), 'Ontem');
assert.match(L.rotuloDia('2026-11-05', '2026-11-20'), /5 de nov/);

// Validacao: cada campo obrigatorio tem sua mensagem; transferencia exige contas diferentes.
const base = { tipo: 'despesa', valor: 10, descricao: 'Mercado', data: '2026-11-02', conta_id: 'a', categoria_id: 'c' };
assert.equal(L.validarLancamento(base), null);
assert.match(L.validarLancamento({ ...base, valor: null }), /valor/);
assert.match(L.validarLancamento({ ...base, descricao: '   ' }), /descrição/);
assert.match(L.validarLancamento({ ...base, descricao: 'x'.repeat(121) }), /120/);
assert.match(L.validarLancamento({ ...base, data: '2026-13-01' }), /data/);
assert.match(L.validarLancamento({ ...base, conta_id: '' }), /conta/);
assert.match(L.validarLancamento({ ...base, categoria_id: '' }), /categoria/);
assert.match(L.validarLancamento({ ...base, tipo: 'x' }), /tipo/);
const transf = { ...base, tipo: 'transferencia', categoria_id: '', conta_destino_id: 'b' };
assert.equal(L.validarLancamento(transf), null);
assert.match(L.validarLancamento({ ...transf, conta_destino_id: '' }), /destino/);
assert.match(L.validarLancamento({ ...transf, conta_destino_id: 'a' }), /diferente/);

// Registro enviado ao banco segue a regra "transferencia_consistente".
assert.deepEqual(L.montarRegistro({ ...transf, categoria_id: 'c', observacoes: '  ' }),
  { tipo: 'transferencia', descricao: 'Mercado', valor: 10, data: '2026-11-02', conta_id: 'a', conta_destino_id: 'b', categoria_id: null, pago: false, observacoes: null });
assert.deepEqual(L.montarRegistro({ ...base, conta_destino_id: 'b', pago: true, descricao: ' Mercado ', observacoes: ' ok ' }),
  { tipo: 'despesa', descricao: 'Mercado', valor: 10, data: '2026-11-02', conta_id: 'a', conta_destino_id: null, categoria_id: 'c', pago: true, observacoes: 'ok' });

// Totais: so o que ja foi pago; transferencias nao contam; centavos exatos.
const lista = [
  { tipo: 'receita', valor: 3000, pago: true, data: '2026-11-05', descricao: 'Salário', conta_id: 'a', categoria_id: 's' },
  { tipo: 'despesa', valor: 0.1, pago: true, data: '2026-11-05', descricao: 'Bala', conta_id: 'a', categoria_id: 'c' },
  { tipo: 'despesa', valor: 0.2, pago: true, data: '2026-11-02', descricao: 'Café', conta_id: 'b', categoria_id: 'c' },
  { tipo: 'despesa', valor: 500, pago: false, data: '2026-11-20', descricao: 'Aluguel', conta_id: 'a', categoria_id: 'm' },
  { tipo: 'transferencia', valor: 100, pago: true, data: '2026-11-03', descricao: 'Guardar', conta_id: 'a', conta_destino_id: 'b' }
];
assert.deepEqual(L.totaisLancamentos(lista), { entradas: 3000, saidas: 0.3, resultado: 2999.7, pendente: -500 });
assert.deepEqual(L.totaisLancamentos([]), { entradas: 0, saidas: 0, resultado: 0, pendente: 0 });
assert.deepEqual(L.agruparPorDia(lista).map(([d, i]) => [d, i.length]), [['2026-11-20', 1], ['2026-11-05', 2], ['2026-11-03', 1], ['2026-11-02', 1]]);

// Filtros: conta pega origem e destino; busca ignora acentos e maiusculas.
assert.equal(L.filtrarLancamentos(lista, { conta: 'b' }).length, 2);
assert.equal(L.filtrarLancamentos(lista, { categoria: 'c' }).length, 2);
assert.equal(L.filtrarLancamentos(lista, { busca: 'CAFE' })[0].descricao, 'Café');
assert.equal(L.filtrarLancamentos(lista, { busca: 'salario' }).length, 1);
assert.equal(L.filtrarLancamentos(lista, {}).length, 5);

// Mensagens de erro do banco em portugues.
assert.match(L.mensagemErroBanco({ message: 'Failed to fetch' }), /conexão/);
assert.match(L.mensagemErroBanco({ code: '23503', message: 'fk' }), /não existe mais/);
assert.match(L.mensagemErroBanco({ code: '23514', message: 'check' }), /inválido/);
assert.match(L.mensagemErroBanco({ message: 'JWT expired' }), /sessão/);
console.log('Lancamentos aprovados: valores em reais, datas, validacao, totais e filtros.');
