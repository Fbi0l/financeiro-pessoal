// Relatorio do mes no Assistente: calculado no aparelho, sem IA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const A = require('../app.js');

const cats = [
  { id: 'tr', nome: 'Transporte', cor: '#1971c2', tipo: 'despesa' },
  { id: 'al', nome: 'Alimentação', cor: '#e8590c', tipo: 'despesa' },
  { id: 'sa', nome: 'Salário', cor: '#2f9e44', tipo: 'receita' }
];
const L = [
  { tipo: 'receita', valor: 2000, pago: true, data: '2026-11-04', descricao: 'Salário', categoria_id: 'sa' },
  { tipo: 'despesa', valor: 0.1, pago: true, data: '2026-11-05', descricao: 'Uber', categoria_id: 'tr' },
  { tipo: 'despesa', valor: 0.2, pago: true, data: '2026-11-06', descricao: 'Uber', categoria_id: 'tr' },
  { tipo: 'despesa', valor: 59.8, pago: true, data: '2026-11-11', descricao: 'Almoço', categoria_id: 'al' },
  { tipo: 'despesa', valor: 40, pago: true, data: '2026-11-12', descricao: 'Sem cat', categoria_id: null },
  { tipo: 'despesa', valor: 100, pago: false, data: '2026-11-20', descricao: 'Conta de luz', categoria_id: null },
  { tipo: 'receita', valor: 50, pago: false, data: '2026-11-25', descricao: 'Pix a receber', categoria_id: null },
  { tipo: 'transferencia', valor: 870, pago: true, data: '2026-11-04', descricao: 'PJ -> Nubank', categoria_id: null }
];

// Totais: transferencia nao e entrada nem saida; pendentes ficam separados; centavos exatos (0,1 + 0,2).
let r = A.relatorioMes(L, cats, { ano: 2026, mes: 11, hoje: '2026-11-17', saldoHoje: 960.02 });
assert.equal(r.entradas, 2000);
assert.equal(r.saidas, 100.1);
assert.equal(r.resultado, 1899.9);
assert.equal(r.a_pagar, 100); assert.equal(r.a_receber, 50);
assert.equal(r.quantidade_saidas, 4);

// Categorias: ordem do maior para o menor, percentuais, "Sem categoria" e quantidade.
assert.deepEqual(r.categorias.map(c => [c.nome, c.total, c.pct, c.quantidade]),
  [['Alimentação', 59.8, 60, 1], ['Sem categoria', 40, 40, 1], ['Transporte', 0.3, 0, 2]]);
assert.equal(r.categorias[0].cor, '#e8590c'); assert.equal(r.categorias[1].cor, null);

// Maiores gastos: so pagos, no maximo 5, do maior para o menor.
assert.deepEqual(r.maiores.map(g => g.descricao), ['Almoço', 'Sem cat', 'Uber', 'Uber']);
assert.equal(r.maiores[0].categoria, 'Alimentação');

// Ritmo (mes em andamento): 100,10 em 17 dias = 5,89/dia; 13 dias restantes = 76,57.
// Disponivel = saldo de hoje - a pagar + a receber = 960,02 - 100 + 50 = 910,02.
assert.equal(r.em_andamento, true);
assert.deepEqual(r.ritmo, { dia: 17, dias_restantes: 13, media_dia: 5.89, projecao_restante: 76.57, disponivel: 910.02, sobra_estimada: 833.45, situacao: 'ok' });

// Mes apertado: gastos altos e pouco saldo.
const caro = [{ tipo: 'despesa', valor: 1352.42, pago: true, data: '2026-11-10', descricao: 'x', categoria_id: 'al' }];
r = A.relatorioMes(caro, cats, { ano: 2026, mes: 11, hoje: '2026-11-17', saldoHoje: 960.02 });
assert.equal(r.ritmo.situacao, 'apertado');
assert.equal(r.ritmo.media_dia, 79.55);
assert.equal(r.ritmo.projecao_restante, 1034.15);
assert.equal(r.ritmo.sobra_estimada, -74.13);

// Mes passado: sem ritmo. Ultimo dia do mes: situacao 'fim'. Sem gastos: 'sem-gastos'.
assert.equal(A.relatorioMes(caro, cats, { ano: 2026, mes: 10, hoje: '2026-11-17' }).ritmo, null);
assert.equal(A.relatorioMes(caro, cats, { ano: 2026, mes: 11, hoje: '2026-11-30' }).ritmo.situacao, 'fim');
assert.equal(A.relatorioMes([], cats, { ano: 2026, mes: 11, hoje: '2026-11-17' }).ritmo.situacao, 'sem-gastos');
// Lista vazia ou nula nao quebra.
r = A.relatorioMes(null, null, { ano: 2026, mes: 2, hoje: '2026-02-01' });
assert.equal(r.saidas, 0); assert.deepEqual(r.categorias, []); assert.deepEqual(r.maiores, []);
// So 5 maiores.
const muitos = Array.from({ length: 9 }, (_, i) => ({ tipo: 'despesa', valor: i + 1, pago: true, data: '2026-11-01', descricao: 'g' + i, categoria_id: 'al' }));
assert.deepEqual(A.relatorioMes(muitos, cats, { ano: 2026, mes: 11 }).maiores.map(g => g.valor), [9, 8, 7, 6, 5]);

// Pagina: elementos do relatorio existem no Assistente.
const html = fs.readFileSync('index.html', 'utf8');
for (const id of ['relMensagem', 'relVazio', 'relConteudo', 'relEntradas', 'relSaidas', 'relResultado', 'relPendente', 'relRitmo', 'relRitmoTitulo', 'relRitmoTexto', 'relCategorias', 'relQtdSaidas', 'relMaioresBox', 'relMaiores'])
  assert.ok(html.includes(`id="${id}"`), `index.html tem #${id}`);
console.log('Relatorio do mes aprovado: totais, pendentes, categorias, maiores gastos e ritmo de gasto.');
