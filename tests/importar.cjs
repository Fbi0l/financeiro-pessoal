// Leitura de extratos (OFX e CSV), identificadores, sugestao de categoria e previa da importacao.
const assert = require('node:assert/strict');
const I = require('../importar.js');
const bytes1252 = s => Uint8Array.from(Buffer.from(s, 'latin1'));

// ---------- Numeros e datas ----------
const numeros = { '-1.234,56': -1234.56, '1234.56': 1234.56, '(12,00)': -12, 'R$ -10': -10, '12,00-': -12, '+5': 5, '-50.00': -50,
  '1.234.567,89': 1234567.89, '1,234,567.89': 1234567.89, '0,1': 0.1, '−7,5': -7.5, '1.000.000': 1000000 };
for (const [t, v] of Object.entries(numeros)) assert.equal(I.lerNumero(t), v, `lerNumero(${t})`);
for (const t of ['', 'abc', '1-2', null]) assert.equal(I.lerNumero(t), null, `recusa ${t}`);
const datas = { '31/12/2026': '2026-12-31', '01-02-26': '2026-02-01', '2026-03-04': '2026-03-04', '20261105120000[-3:BRT]': '2026-11-05', '5/1/2026': '2026-01-05' };
for (const [t, v] of Object.entries(datas)) assert.equal(I.lerData(t), v, `lerData(${t})`);
for (const t of ['31/02/2026', 'ontem', '2026/13/01', '']) assert.equal(I.lerData(t), null, `data invalida ${t}`);

// ---------- OFX 1.x (SGML, sem fechar tags) em Windows-1252, como alguns bancos exportam ----------
const ofx1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0341<BRANCHID>1234<ACCTID>56789-0</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002100000[-3:BRT]<TRNAMT>-45.90<FITID>20261002001<MEMO>SUPERMERCADO NAZARÉ
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>3500.00<FITID>20261005001<MEMO>PAGTO SALARIO
<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20261005<TRNAMT>0.00<FITID>20261005002<MEMO>SALDO ANTERIOR
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261010<TRNAMT>-23,50<FITID>20261010001<NAME>UBER *TRIP<MEMO>Compra no débito
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261010<TRNAMT>-23,50<FITID>20261010001<NAME>UBER *TRIP<MEMO>Compra no débito
</BANKTRANLIST><LEDGERBAL><BALAMT>3407.10<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const t1 = I.decodificar(bytes1252(ofx1));
assert.ok(t1.includes('NAZARÉ') && t1.includes('débito'), 'acentos em Windows-1252');
const e1 = I.lerExtrato(t1, 'extrato.ofx');
assert.equal(e1.formato, 'OFX'); assert.equal(e1.tipoExtrato, 'conta'); assert.equal(e1.banco, '0341'); assert.equal(e1.conta, '56789-0');
assert.equal(e1.saldoFinal, 3407.10);
assert.equal(e1.movimentos.length, 4, 'linha de saldo e valor zero descartados');
assert.deepEqual(e1.movimentos.map(m => [m.data, m.valor]), [['2026-10-02', -45.9], ['2026-10-05', 3500], ['2026-10-10', -23.5], ['2026-10-10', -23.5]]);
assert.equal(e1.movimentos[0].descricao, 'SUPERMERCADO NAZARÉ');
assert.equal(e1.movimentos[2].descricao, 'UBER *TRIP - Compra no débito', 'NAME e MEMO combinados');
assert.deepEqual(I.idsExternos(e1.movimentos), ['b:20261002001', 'b:20261005001', 'b:20261010001', 'b:20261010001#2'], 'FITID repetido no arquivo nao se perde');

// ---------- OFX 2.x (XML) em UTF-8, com cartao de credito ----------
const ofx2 = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="211"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>1111</ACCTID></CCACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>-89.90</TRNAMT><FITID>abc-1</FITID><MEMO>Netflix.com &amp; Co</MEMO></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
const e2 = I.lerExtrato(I.decodificar(new TextEncoder().encode(ofx2)));
assert.equal(e2.tipoExtrato, 'cartao', 'fatura de cartao reconhecida');
assert.equal(e2.movimentos[0].descricao, 'Netflix.com & Co');

// ---------- CSV da conta Nubank ----------
const nubank = `Data,Valor,Identificador,Descrição
01/11/2026,-12.50,6a1f-01,Compra no débito - Padaria Pão Quente
02/11/2026,1500.00,6a1f-02,Transferência recebida pelo Pix - FULANO
03/11/2026,-200.00,6a1f-03,"Transferência enviada pelo Pix - Aluguel, novembro"`;
const e3 = I.lerExtrato(I.decodificar(new TextEncoder().encode('﻿' + nubank)));
assert.equal(e3.formato, 'CSV do Nubank');
assert.deepEqual(e3.movimentos.map(m => m.valor), [-12.5, 1500, -200]);
assert.equal(e3.movimentos[2].descricao, 'Transferência enviada pelo Pix - Aluguel, novembro', 'virgula dentro de aspas');
assert.deepEqual(I.idsExternos(e3.movimentos), ['b:6a1f-01', 'b:6a1f-02', 'b:6a1f-03']);

// ---------- CSV generico: ponto e virgula, cabecalho depois de um preambulo, saldo e rodape ----------
const generico = `Extrato de conta corrente
Agência 0001 Conta 12345
Data;Histórico;Valor (R$)
04/11/2026;SALDO ANTERIOR;1.000,00
05/11/2026;DROGARIA EXTRAFARMA;-1.234,56
05/11/2026;CAFE DA PRAÇA;-8,00
05/11/2026;CAFE DA PRAÇA;-8,00
Total;;-1.250,56`;
const e4 = I.lerExtrato(I.decodificar(bytes1252(generico)));
assert.equal(e4.formato, 'CSV');
assert.equal(e4.movimentos.length, 3); assert.equal(e4.descartados.saldo, 1);
assert.equal(e4.movimentos[0].valor, -1234.56); assert.equal(e4.movimentos[1].descricao, 'CAFE DA PRAÇA');
const ids4 = I.idsExternos(e4.movimentos);
assert.ok(ids4[1].startsWith('h:2026-11-05:-800:') && ids4[2] === ids4[1] + '#2', 'dois cafes iguais no mesmo dia viram dois lancamentos');
assert.deepEqual(I.idsExternos(I.lerExtrato(I.decodificar(bytes1252(generico))).movimentos), ids4, 'mesmo arquivo gera os mesmos identificadores');

// ---------- CSV do PicPay: "origem / destino", tipo da operacao, hora e sinal unicode "−R$" ----------
const picpay = 'data,hora,tipo,"origem / destino",valor,"forma de pagamento"\n' +
  '2026-10-19,22:57,"Compra realizada","PicPay Shop","−R$ 25,00","Com saldo"\n' +
  '2026-10-19,22:54,"Pix recebido","Fulano de Tal","+R$ 25,00",\n' +
  '2026-10-20,08:00,"Pix enviado","Padaria","−R$ 1.234,50","Com saldo"\n' +
  '2026-10-20,08:00,"Pix enviado","Padaria","−R$ 1.234,50","Com saldo"\n';
const ePP = I.lerExtrato(picpay);
assert.equal(ePP.formato, 'CSV do PicPay');
assert.deepEqual(ePP.movimentos.map(m => [m.data, m.valor, m.descricao]), [
  ['2026-10-19', -25, 'Compra realizada - PicPay Shop'], ['2026-10-19', 25, 'Pix recebido - Fulano de Tal'],
  ['2026-10-20', -1234.5, 'Pix enviado - Padaria'], ['2026-10-20', -1234.5, 'Pix enviado - Padaria']]);
const idsPP = I.idsExternos(ePP.movimentos);
assert.equal(new Set(idsPP).size, 4, 'iguais no mesmo minuto nao se perdem');
assert.deepEqual(I.idsExternos(I.lerExtrato('﻿' + picpay).movimentos), idsPP, 'mesmo arquivo do PicPay gera os mesmos identificadores');

// ---------- CSV do Banco do Brasil (formato atual): Detalhes, tipo e documento repetido ----------
const bb = `"Data","Lançamento","Detalhes","N° documento","Valor","Tipo Lançamento"
"01/10/2026","Saldo Anterior","","","1.500,00",""
"03/10/2026","Pix - Enviado","03/10 14:22 Maria Souza","100301","-50,00","Saída"
"03/10/2026","Tarifa Pacote de Serviços","","11","-32,50","Saída"
"05/10/2026","Pix - Recebido","05/10 09:10 João Lima","100501","200,00","Entrada"
"07/10/2026","Compra com Cartão","07/10 12:00 SUPERMERCADO BOM PRECO","11","45,90","Saída"
"31/10/2026","S A L D O","","","1.572,60",""`;
const eBB = I.lerExtrato(I.decodificar(bytes1252(bb)));
assert.equal(eBB.formato, 'CSV do Banco do Brasil');
assert.equal(eBB.movimentos.length, 4); assert.equal(eBB.descartados.saldo, 2);
assert.deepEqual(eBB.movimentos.map(m => m.valor), [-50, -32.5, 200, -45.9], 'Tipo Lançamento manda no sinal');
assert.deepEqual(eBB.movimentos.map(m => m.descricao), ['Pix - Enviado - Maria Souza', 'Tarifa Pacote de Serviços', 'Pix - Recebido - João Lima', 'Compra com Cartão - SUPERMERCADO BOM PRECO']);
const idsBB = I.idsExternos(eBB.movimentos);
assert.equal(new Set(idsBB).size, 4, 'documento "11" repetido nao faz lancamentos diferentes parecerem iguais');
assert.ok(idsBB.every(id => !id.startsWith('b:11')), 'documento sozinho nao vira identificador');
// Mesmo documento em outro mes, outro valor: identificador diferente (nao some na importacao seguinte).
const bbNov = bb.replace('"03/10/2026","Tarifa Pacote de Serviços","","11","-32,50"', '"03/11/2026","Tarifa Pacote de Serviços","","11","-34,00"');
assert.notEqual(I.idsExternos(I.lerExtrato(bbNov).movimentos)[1], idsBB[1]);
assert.deepEqual(I.idsExternos(I.lerExtrato(I.decodificar(bytes1252(bb))).movimentos), idsBB, 'mesmo arquivo do BB gera os mesmos identificadores');

// ---------- CSV do Banco do Brasil (formato antigo, ponto decimal) ----------
const bbAntigo = `"Data","Dependencia Origem","Histórico","Data do Balancete","Número do documento","Valor",
"01/10/2026","","Saldo Anterior","","0","1500.00",
"04/10/2026","","Pagto conta energia","","0","-189.35",
"06/10/2026","0001","Transferência recebida","","553201","1250.00",
"31/10/2026","","S A L D O","","0","2560.65",`;
const eBBa = I.lerExtrato(bbAntigo);
assert.equal(eBBa.formato, 'CSV do Banco do Brasil');
assert.deepEqual(eBBa.movimentos.map(m => [m.data, m.valor, m.descricao]), [['2026-10-04', -189.35, 'Pagto conta energia'], ['2026-10-06', 1250, 'Transferência recebida']]);
assert.equal(eBBa.movimentos[0].fitid, '', 'documento "0" e ignorado');

// ---------- CSV com colunas de credito e debito ----------
const credDeb = `Data,Lançamento,Crédito,Débito\n10/11/2026,PIX RECEBIDO JOAO,250,\n11/11/2026,POSTO IPIRANGA,,180.5`;
assert.deepEqual(I.lerExtrato(credDeb).movimentos.map(m => m.valor), [250, -180.5]);

// ---------- Fatura do cartao Nubank (compras positivas viram saidas) ----------
const cartao = `date,title,amount\n2026-11-02,Ifood,45.90\n2026-11-03,Pagamento recebido,-500.00`;
const e5 = I.lerExtrato(cartao);
assert.equal(e5.tipoExtrato, 'cartao'); assert.deepEqual(e5.movimentos.map(m => m.valor), [-45.9, 500]);

// ---------- Erros claros ----------
assert.throws(() => I.lerExtrato('nome;idade\nana;30'), e => e.codigo === 'csv_colunas');
const muitas = 'Data;Descrição;Valor\n' + Array.from({ length: 3001 }, (_, i) => `01/11/2026;Item ${i};-1,00`).join('\n');
assert.throws(() => I.lerExtrato(muitas), e => e.codigo === 'muitas_linhas');

// ---------- Sugestao de categoria ----------
const cats = [
  { id: 'sup', nome: 'Supermercado', tipo: 'despesa' }, { id: 'ali', nome: 'Alimentação', tipo: 'despesa' },
  { id: 'tra', nome: 'Transporte', tipo: 'despesa' }, { id: 'sau', nome: 'Saúde', tipo: 'despesa' },
  { id: 'out', nome: 'Outras despesas', tipo: 'despesa' }, { id: 'sal', nome: 'Salário', tipo: 'receita' },
  { id: 'pix', nome: 'Pix recebido', tipo: 'receita' }, { id: 'our', nome: 'Outras receitas', tipo: 'receita' },
  { id: 'lzr', nome: 'Lazer', tipo: 'despesa' }, { id: 'old', nome: 'Antiga', tipo: 'despesa', arquivada: true }
];
assert.equal(I.chaveDescricao('Compra no débito - PADARIA PÃO QUENTE 1234'), 'padaria pao quente');
assert.equal(I.chaveDescricao('PADARIA PAO QUENTE 05/11'), 'padaria pao quente');
const hist = I.montarHistorico([
  { tipo: 'despesa', descricao: 'Padaria Pão Quente 0311', categoria_id: 'lzr' },
  { tipo: 'despesa', descricao: 'Padaria Pão Quente 0101', categoria_id: 'ali' },
  { tipo: 'despesa', descricao: 'Coisa velha', categoria_id: 'old' }
]);
assert.deepEqual(I.sugerirCategoria('Compra no débito - Padaria Pão Quente', 'despesa', cats, hist), { id: 'lzr', motivo: 'historico' }, 'historico (mais recente) vence');
assert.deepEqual(I.sugerirCategoria('UBER *TRIP', 'despesa', cats, hist), { id: 'tra', motivo: 'palavra' });
assert.deepEqual(I.sugerirCategoria('SUPERMERCADO NAZARÉ', 'despesa', cats, hist), { id: 'sup', motivo: 'palavra' });
assert.deepEqual(I.sugerirCategoria('DROGARIA EXTRAFARMA', 'despesa', cats, hist), { id: 'sau', motivo: 'palavra' });
assert.deepEqual(I.sugerirCategoria('PAGTO SALARIO', 'receita', cats, hist), { id: 'sal', motivo: 'palavra' });
assert.deepEqual(I.sugerirCategoria('Transferência recebida pelo Pix - FULANO', 'receita', cats, hist), { id: 'pix', motivo: 'palavra' });
assert.deepEqual(I.sugerirCategoria('XPTO LTDA', 'despesa', cats, hist), { id: 'out', motivo: 'padrao' });
assert.deepEqual(I.sugerirCategoria('Coisa velha', 'despesa', cats, hist), { id: 'out', motivo: 'padrao' }, 'categoria arquivada nao e sugerida');
assert.deepEqual(I.sugerirCategoria('SALARIO', 'despesa', cats, hist), { id: 'out', motivo: 'padrao' }, 'so categorias do mesmo tipo');

// ---------- Previa: ja importados, parecidos com manuais, totais e registros ----------
const previa = I.prepararPrevia(e1, {
  categorias: cats, historico: hist,
  idsExistentes: new Set(['b:20261005001']),
  existentes: [{ data: '2026-10-02', tipo: 'despesa', valor: '45.90', id_externo: null }]
});
assert.deepEqual(previa.map(l => l.situacao), ['parecida', 'importada', 'nova', 'nova']);
assert.deepEqual(previa.map(l => l.incluir), [false, false, true, true], 'so as novas vem marcadas');
assert.deepEqual(previa.map(l => [l.tipo, l.valor]), [['despesa', 45.9], ['receita', 3500], ['despesa', 23.5], ['despesa', 23.5]]);
const res = I.resumoPrevia(previa);
assert.deepEqual([res.total, res.novas, res.importadas, res.parecidas, res.incluidas, res.entradas, res.saidas, res.inicio, res.fim],
  [4, 2, 1, 1, 2, 0, 47, '2026-10-02', '2026-10-10']);
const regs = I.registrosParaGravar(previa, 'conta-1', 'imp-1');
assert.equal(regs.length, 2);
assert.deepEqual(regs[0], { tipo: 'despesa', descricao: 'UBER *TRIP - Compra no débito', valor: 23.5, data: '2026-10-10', conta_id: 'conta-1',
  conta_destino_id: null, categoria_id: 'tra', pago: true, observacoes: null, origem: 'importacao', id_externo: 'b:20261010001', importacao_id: 'imp-1' });
// Registro da importacao: periodo das linhas marcadas, nome do arquivo limpo e limitado.
assert.deepEqual(I.dadosDaImportacao(previa, { formato: 'OFX' }, '  extrato   outubro.ofx ', 'conta-1'),
  { conta_id: 'conta-1', arquivo: 'extrato outubro.ofx', formato: 'OFX', periodo_inicio: regs.map(r => r.data).sort()[0], periodo_fim: regs.map(r => r.data).sort().pop() });
assert.equal(I.dadosDaImportacao(previa, null, 'x'.repeat(300), 'c').arquivo.length, 120);
assert.equal(I.dadosDaImportacao(previa.map(l => ({ ...l, incluir: false })), null, 'a.ofx', 'c'), null, 'nada marcado, nada a registrar');
console.log('Importacao aprovada: OFX 1 e 2, CSV Nubank, Banco do Brasil, PicPay e generico, acentos, saldo descartado, identificadores, categorias, previa e registro da importacao.');
