// Cálculos do agente financeiro (funções puras, sem rede).
// A IA só interpreta: todos os números que ela vê saem daqui, calculados em centavos.
// Testado em tests/agente.mjs.

const c = v => Math.round(Number(v || 0) * 100);
const r = cent => Math.round(cent) / 100;
const doisDigitos = n => String(n).padStart(2, '0');

export function mesDe(iso) { return String(iso).slice(0, 7); }
export function somarMeses(mes, delta) {
  const [a, m] = mes.split('-').map(Number);
  const t = a * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${doisDigitos((t % 12) + 1)}`;
}
export function intervaloMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const fim = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { inicio: `${mes}-01`, fim: `${mes}-${doisDigitos(fim)}` };
}
export function mesValido(mes) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || '')) && Number(mes.slice(0, 4)) >= 2000 && Number(mes.slice(0, 4)) <= 2100;
}

const semAcento = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Mesmo critério do importador: descrição sem números e palavras de transação, para reconhecer o estabelecimento. */
export function chaveDescricao(s) {
  return semAcento(s).replace(/\d+/g, ' ').replace(/[^a-z ]/g, ' ')
    .replace(/\b(pix|ted|doc|compra|pagamento|pagto|pag|debito|credito|cartao|transf(erencia)?|enviad[oa]|recebid[oa]|no|na|de|do|da|em|com)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Monta o pacote de dados de um mês para o relatório.
 * lancamentos: todos os do período [mês-11 .. mês] (o histórico serve para comparar e achar recorrentes).
 */
export function montarPacote({ lancamentos, contas, categorias, mes, hoje }) {
  const nomeCat = new Map((categorias || []).map(x => [x.id, x.nome]));
  const nomeConta = new Map((contas || []).map(x => [x.id, x.nome]));
  const meses = Array.from({ length: 12 }, (_, i) => somarMeses(mes, i - 11));
  const pagos = (lancamentos || []).filter(l => l.pago && l.tipo !== 'transferencia');

  // Histórico mensal (12 meses) e por categoria.
  const porMes = new Map(meses.map(m => [m, { entradas: 0, saidas: 0 }]));
  const catMes = new Map(); // categoria -> Map(mes -> centavos)
  for (const l of pagos) {
    const m = mesDe(l.data);
    const pm = porMes.get(m);
    if (!pm) continue;
    if (l.tipo === 'receita') pm.entradas += c(l.valor);
    else {
      pm.saidas += c(l.valor);
      const cat = nomeCat.get(l.categoria_id) || 'Sem categoria';
      if (!catMes.has(cat)) catMes.set(cat, new Map());
      catMes.get(cat).set(m, (catMes.get(cat).get(m) || 0) + c(l.valor));
    }
  }
  const atual = porMes.get(mes);
  const anteriores3 = [1, 2, 3].map(i => somarMeses(mes, -i));
  const mesesComDados = anteriores3.filter(m => (porMes.get(m)?.saidas || 0) + (porMes.get(m)?.entradas || 0) > 0);

  const porCategoria = [...catMes.entries()].map(([categoria, mapa]) => {
    const total = mapa.get(mes) || 0;
    const anterior = mapa.get(somarMeses(mes, -1)) || 0;
    const media3 = mesesComDados.length ? mesesComDados.reduce((s, m) => s + (mapa.get(m) || 0), 0) / mesesComDados.length : null;
    return {
      categoria, total: r(total), mes_anterior: r(anterior),
      media_3_meses: media3 == null ? null : r(media3),
      variacao_vs_media_pct: media3 ? Math.round((total - media3) / media3 * 100) : null,
      participacao_pct: atual.saidas ? Math.round(total / atual.saidas * 100) : 0
    };
  }).filter(x => x.total || x.mes_anterior).sort((a, b) => b.total - a.total);

  const doMes = (lancamentos || []).filter(l => mesDe(l.data) === mes);
  const maioresGastos = doMes.filter(l => l.pago && l.tipo === 'despesa')
    .sort((a, b) => c(b.valor) - c(a.valor)).slice(0, 10)
    .map(l => ({ data: l.data, descricao: l.descricao, valor: r(c(l.valor)), categoria: nomeCat.get(l.categoria_id) || 'Sem categoria', conta: nomeConta.get(l.conta_id) || '' }));

  // Recorrentes: mesmo estabelecimento em pelo menos 3 dos últimos 4 meses, com valor parecido (±25%).
  const grupos = new Map();
  for (const l of pagos) {
    if (l.tipo !== 'despesa') continue;
    const m = mesDe(l.data);
    if (!meses.slice(-4).includes(m)) continue;
    const k = chaveDescricao(l.descricao);
    if (!k) continue;
    if (!grupos.has(k)) grupos.set(k, { descricao: l.descricao, porMes: new Map(), categoria: nomeCat.get(l.categoria_id) || 'Sem categoria' });
    const g = grupos.get(k);
    g.porMes.set(m, (g.porMes.get(m) || 0) + c(l.valor));
    g.descricao = l.descricao;
  }
  const recorrentes = [...grupos.values()].filter(g => g.porMes.size >= 3).map(g => {
    const vals = [...g.porMes.values()];
    const media = vals.reduce((s, v) => s + v, 0) / vals.length;
    const estavel = vals.every(v => Math.abs(v - media) <= media * 0.25);
    return { descricao: g.descricao, categoria: g.categoria, valor_medio_mensal: r(media), meses: g.porMes.size, valor_estavel: estavel };
  }).sort((a, b) => b.valor_medio_mensal - a.valor_medio_mensal).slice(0, 15);

  const pendentes = doMes.filter(l => !l.pago && l.tipo !== 'transferencia');
  const [ano, mm] = mes.split('-').map(Number);
  const diasNoMes = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
  const mesAtualEmAndamento = hoje && mesDe(hoje) === mes;

  return {
    mes,
    mes_em_andamento: !!mesAtualEmAndamento,
    dia_atual: mesAtualEmAndamento ? Number(hoje.slice(8, 10)) : diasNoMes,
    dias_no_mes: diasNoMes,
    totais: {
      entradas: r(atual.entradas), saidas: r(atual.saidas), resultado: r(atual.entradas - atual.saidas),
      a_pagar: r(pendentes.filter(l => l.tipo === 'despesa').reduce((s, l) => s + c(l.valor), 0)),
      a_receber: r(pendentes.filter(l => l.tipo === 'receita').reduce((s, l) => s + c(l.valor), 0)),
      quantidade_lancamentos: doMes.length
    },
    historico_mensal: meses.map(m => ({ mes: m, entradas: r(porMes.get(m).entradas), saidas: r(porMes.get(m).saidas) })).filter(x => x.entradas || x.saidas),
    por_categoria: porCategoria,
    maiores_gastos: maioresGastos,
    recorrentes
  };
}

/** Lançamentos do mês em linhas compactas (economiza tokens): data|valor com sinal|categoria|conta|descrição|situação. */
export function linhasLancamentos(lancamentos, categorias, contas, limite = 400) {
  const nomeCat = new Map((categorias || []).map(x => [x.id, x.nome]));
  const nomeConta = new Map((contas || []).map(x => [x.id, x.nome]));
  return (lancamentos || []).slice(0, limite).map(l => {
    const sinal = l.tipo === 'receita' ? '+' : l.tipo === 'despesa' ? '-' : '~';
    const destino = l.tipo === 'transferencia' ? `->${nomeConta.get(l.conta_destino_id) || '?'}` : '';
    return [l.data, sinal + r(c(l.valor)).toFixed(2), l.tipo === 'transferencia' ? 'Transferência' : (nomeCat.get(l.categoria_id) || 'Sem categoria'),
      (nomeConta.get(l.conta_id) || '?') + destino, String(l.descricao).replace(/[|\n\r]/g, ' ').slice(0, 80), l.pago ? '' : 'pendente'].join('|');
  }).join('\n');
}

/** Agrupa lançamentos por categoria ou estabelecimento, para a ferramenta de resumo do chat. */
export function agrupar(lancamentos, categorias, por = 'categoria') {
  const nomeCat = new Map((categorias || []).map(x => [x.id, x.nome]));
  const g = new Map();
  for (const l of lancamentos || []) {
    if (!l.pago || l.tipo === 'transferencia') continue;
    const k = por === 'estabelecimento' ? (chaveDescricao(l.descricao) || l.descricao) : (nomeCat.get(l.categoria_id) || 'Sem categoria');
    const item = g.get(k + '|' + l.tipo) || { nome: k, tipo: l.tipo, total: 0, quantidade: 0 };
    item.total += c(l.valor); item.quantidade++;
    g.set(k + '|' + l.tipo, item);
  }
  return [...g.values()].map(x => ({ ...x, total: r(x.total) })).sort((a, b) => b.total - a.total).slice(0, 40);
}

const TIPOS_DESTAQUE = ['alerta', 'economia', 'positivo', 'dica'];
const PRIORIDADES = ['alta', 'media', 'baixa'];
/** Extrai e valida o JSON do relatório devolvido pela IA. Devolve null se não der para aproveitar. */
export function validarRelatorio(texto) {
  if (!texto) return null;
  let obj = null;
  const bruto = String(texto).replace(/^```(json)?|```$/gm, '').trim();
  try { obj = JSON.parse(bruto); } catch (_) {
    const i = bruto.indexOf('{'), f = bruto.lastIndexOf('}');
    if (i >= 0 && f > i) { try { obj = JSON.parse(bruto.slice(i, f + 1)); } catch (_) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return null;
  const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const resumo = txt(obj.resumo, 700);
  const destaques = (Array.isArray(obj.destaques) ? obj.destaques : []).slice(0, 8).map(d => {
    const tipo = semAcento(d?.tipo);
    const prioridade = semAcento(d?.prioridade).replace('é', 'e');
    const eco = Number(d?.economia_mensal_estimada);
    return {
      titulo: txt(d?.titulo, 90), detalhe: txt(d?.detalhe, 500),
      tipo: TIPOS_DESTAQUE.includes(tipo) ? tipo : 'dica',
      prioridade: PRIORIDADES.includes(prioridade) ? prioridade : 'media',
      economia_mensal_estimada: Number.isFinite(eco) && eco > 0 ? Math.round(eco * 100) / 100 : null
    };
  }).filter(d => d.titulo && d.detalhe);
  if (!resumo && !destaques.length) return null;
  const ordem = { alta: 0, media: 1, baixa: 2 };
  destaques.sort((a, b) => ordem[a.prioridade] - ordem[b.prioridade]);
  return { resumo, destaques };
}

/** Valida as mensagens do chat vindas do navegador. */
export function validarMensagens(lista) {
  if (!Array.isArray(lista) || !lista.length) return null;
  const msgs = lista.slice(-12).map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content ?? '').slice(0, 2000).trim() }))
    .filter(m => m.content);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  return msgs;
}
