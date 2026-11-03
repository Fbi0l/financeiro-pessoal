/* Financeiro pessoal — frontend estático + Supabase.
   A chave abaixo é a chave PUBLICÁVEL do projeto: ela é feita para ficar no navegador.
   Quem protege os dados são as regras de acesso (RLS) do banco: cada linha só é vista pelo seu dono. */
'use strict';

const SUPABASE_URL = 'https://ruphlnabikvnadlmeisg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_sTlK2zW1wno8zVjutjD9JA_r29jZ1JV';

/* ---------- Funções puras (testadas em tests/logica.cjs) ---------- */
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const VALOR_MAXIMO = 999999999999.99; // limite de numeric(14,2)
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatarMoeda(valor) {
  const n = Number(valor);
  return brl.format(Number.isFinite(n) ? n : 0);
}
function paraCentavos(valor) { return Math.round(Number(valor || 0) * 100); }
function somarSaldos(contas) {
  // Soma em centavos para não acumular erro de ponto flutuante.
  const centavos = (contas || [])
    .filter(c => !c.arquivada)
    .reduce((acc, c) => acc + paraCentavos(c.saldo_atual ?? c.saldo_inicial ?? 0), 0);
  return centavos / 100;
}
function corSegura(cor, padrao = '#6d7b8f') {
  return /^#[0-9a-fA-F]{6}$/.test(String(cor || '')) ? cor : padrao;
}
const TIPOS_CONTA = { corrente: 'Conta corrente', poupanca: 'Poupança', carteira: 'Carteira', investimento: 'Investimento', outro: 'Outro' };
function rotuloTipoConta(tipo) { return TIPOS_CONTA[tipo] || 'Outro'; }
function mensagemErroLogin(error) {
  const m = String(error?.message || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (m.includes('rate limit') || error?.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if (m.includes('fetch') || m.includes('network')) return 'Sem conexão com o servidor. Verifique sua internet.';
  return 'Não foi possível entrar. Tente novamente.';
}

/** Lê um valor digitado em reais ("1.234,56", "1234,5", "12.50", "R$ 10") e devolve número ou null. */
function lerValor(texto) {
  let t = String(texto ?? '').replace(/R\$|\s/gi, '');
  if (!t || !/^[0-9.,]+$/.test(t)) return null;
  if (t.includes(',')) {
    if ((t.match(/,/g) || []).length > 1) return null;
    const [inteiro, dec] = t.split(',');
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(inteiro) || !/^\d{0,2}$/.test(dec)) return null;
    t = inteiro.replace(/\./g, '') + '.' + (dec || '0');
  } else {
    const pontos = (t.match(/\./g) || []).length;
    if (pontos > 1 || /^\d{1,3}\.\d{3}$/.test(t)) { // separador de milhar: 1.234 ou 1.234.567
      if (!/^\d{1,3}(\.\d{3})+$/.test(t)) return null;
      t = t.replace(/\./g, '');
    } else if (pontos === 1 && !/^\d+\.\d{1,2}$/.test(t)) return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > VALOR_MAXIMO) return null;
  return Math.round(n * 100) / 100;
}
/** Valor para mostrar num campo de edição: 1234.5 -> "1.234,50". */
function valorParaCampo(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const doisDigitos = n => String(n).padStart(2, '0');
/** Data de hoje no fuso do aparelho, como AAAA-MM-DD (sem passar por UTC). */
function hojeISO(agora = new Date()) {
  return `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}-${doisDigitos(agora.getDate())}`;
}
/** Primeiro e último dia de um mês (mes = 1..12). */
function intervaloMes(ano, mes) {
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { inicio: `${ano}-${doisDigitos(mes)}-01`, fim: `${ano}-${doisDigitos(mes)}-${doisDigitos(ultimo)}` };
}
function somarMes(ano, mes, delta) {
  const total = ano * 12 + (mes - 1) + delta;
  return { ano: Math.floor(total / 12), mes: (total % 12) + 1 };
}
function rotuloMes(ano, mes) {
  const nome = MESES[mes - 1] || '';
  return nome.charAt(0).toUpperCase() + nome.slice(1) + ' de ' + ano;
}
function dataValida(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && a >= 2000 && a <= 2100;
}
const fmtDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
function rotuloDia(iso, hoje = hojeISO()) {
  if (iso === hoje) return 'Hoje';
  const [a, m, d] = iso.split('-').map(Number);
  const ontem = new Date(Date.UTC(...hoje.split('-').map((v, i) => i === 1 ? v - 1 : Number(v))) - 864e5).toISOString().slice(0, 10);
  if (iso === ontem) return 'Ontem';
  return fmtDia.format(new Date(Date.UTC(a, m - 1, d))).replace(/\./g, '');
}

/** Confere um lançamento antes de enviar. Devolve a mensagem de erro, ou null se estiver tudo certo. */
function validarLancamento(l) {
  if (!['receita', 'despesa', 'transferencia'].includes(l.tipo)) return 'Escolha o tipo do lançamento.';
  if (l.valor == null) return 'Informe um valor maior que zero, como 25,90.';
  const desc = String(l.descricao || '').trim();
  if (!desc) return 'Informe uma descrição.';
  if (desc.length > 120) return 'A descrição pode ter no máximo 120 caracteres.';
  if (!dataValida(l.data)) return 'Informe uma data válida.';
  if (!l.conta_id) return 'Escolha a conta.';
  if (l.tipo === 'transferencia') {
    if (!l.conta_destino_id) return 'Escolha a conta de destino.';
    if (l.conta_destino_id === l.conta_id) return 'A conta de destino precisa ser diferente da conta de origem.';
  } else if (!l.categoria_id) return 'Escolha a categoria.';
  if (l.observacoes && String(l.observacoes).length > 1000) return 'As observações podem ter no máximo 1000 caracteres.';
  return null;
}
/** Monta o registro exatamente como o banco espera (transferência sem categoria; demais sem destino). */
function montarRegistro(l) {
  const transf = l.tipo === 'transferencia';
  const obs = String(l.observacoes || '').trim();
  return {
    tipo: l.tipo, descricao: String(l.descricao).trim(), valor: l.valor, data: l.data,
    conta_id: l.conta_id, conta_destino_id: transf ? l.conta_destino_id : null,
    categoria_id: transf ? null : l.categoria_id, pago: !!l.pago, observacoes: obs || null
  };
}
/** Totais de uma lista: só conta o que já foi pago/recebido; transferências não são entrada nem saída. */
function totaisLancamentos(lista) {
  let ent = 0, sai = 0, pend = 0;
  for (const l of lista || []) {
    const c = paraCentavos(l.valor);
    if (l.tipo === 'transferencia') continue;
    if (!l.pago) { pend += l.tipo === 'despesa' ? -c : c; continue; }
    if (l.tipo === 'receita') ent += c; else sai += c;
  }
  return { entradas: ent / 100, saidas: sai / 100, resultado: (ent - sai) / 100, pendente: pend / 100 };
}
function agruparPorDia(lista) {
  const grupos = new Map();
  for (const l of lista || []) { if (!grupos.has(l.data)) grupos.set(l.data, []); grupos.get(l.data).push(l); }
  return [...grupos.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}
function filtrarLancamentos(lista, { conta = '', categoria = '', busca = '' } = {}) {
  const termo = String(busca).trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '');
  return (lista || []).filter(l =>
    (!conta || l.conta_id === conta || l.conta_destino_id === conta) &&
    (!categoria || l.categoria_id === categoria) &&
    (!termo || String(l.descricao).toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '').includes(termo)));
}
function mensagemErroBanco(error) {
  const m = String(error?.message || '') + ' ' + String(error?.code || '');
  if (/fetch|network/i.test(m)) return 'Sem conexão com o servidor. Verifique sua internet e tente de novo.';
  if (/JWT|401|PGRST301/i.test(m)) return 'Sua sessão expirou. Entre de novo.';
  if (error?.hint === 'categoria_tipo') return 'A categoria não combina com o tipo do lançamento (saída ou entrada). Escolha outra.';
  if (/23503/.test(m)) return 'A conta ou categoria escolhida não existe mais. Atualize a página.';
  if (/23514|22P02|23502/.test(m)) return 'Algum campo ficou inválido. Confira os dados.';
  if (/42501/.test(m)) return 'Sem permissão para esta ação.';
  return 'Não foi possível salvar. Tente novamente.';
}

/* ---------- Contas e categorias ---------- */
const CORES = ['#36418a', '#1971c2', '#0c8599', '#2f9e44', '#8a05be', '#9c36b5', '#d6336c', '#e03131', '#e8590c', '#f08c00', '#8c7a5b', '#6d7b8f'];
const TIPOS_CONTA_VALIDOS = ['corrente', 'poupanca', 'carteira', 'investimento', 'outro'];
/** Saldo informado pela pessoa (pode ser zero ou negativo): "1.234,56", "-50", "0". Devolve número ou null. */
function lerSaldo(texto) {
  const t = String(texto ?? '').replace(/\s|R\$/gi, '');
  if (!t) return null;
  const negativo = /^[-−]/.test(t);
  const corpo = t.replace(/^[-−+]/, '');
  if (/^0+([.,]0{1,2})?$/.test(corpo)) return 0;
  const v = lerValor(corpo);
  return v == null ? null : (negativo ? -v : v);
}
/** Saldo inicial que faz o saldo de hoje bater com o banco: hoje − (efeito dos lançamentos já registrados). */
function saldoInicialPara(saldoHoje, saldoAtual, saldoInicial) {
  const movimentos = paraCentavos(saldoAtual) - paraCentavos(saldoInicial);
  return (paraCentavos(saldoHoje) - movimentos) / 100;
}
function validarConta(c) {
  const nome = String(c.nome || '').trim();
  if (!nome) return 'Informe o nome da conta.';
  if (nome.length > 60) return 'O nome pode ter no máximo 60 caracteres.';
  if (!TIPOS_CONTA_VALIDOS.includes(c.tipo)) return 'Escolha o tipo da conta.';
  if (!/^#[0-9a-fA-F]{6}$/.test(String(c.cor || ''))) return 'Escolha uma cor.';
  if (c.saldo_inicial == null || Math.abs(c.saldo_inicial) > 999999999999.99) return 'Informe um saldo válido, como 1.234,56 ou -50,00.';
  return null;
}
function validarCategoria(c) {
  const nome = String(c.nome || '').trim();
  if (!nome) return 'Informe o nome da categoria.';
  if (nome.length > 40) return 'O nome pode ter no máximo 40 caracteres.';
  if (!['receita', 'despesa'].includes(c.tipo)) return 'Escolha se é de saída ou de entrada.';
  if (!/^#[0-9a-fA-F]{6}$/.test(String(c.cor || ''))) return 'Escolha uma cor.';
  return null;
}
/** Mensagens claras para os erros do banco ao salvar ou excluir contas e categorias. */
function mensagemErroCadastro(error, oque) {
  const m = String(error?.code || '') + ' ' + String(error?.message || '');
  if (/23505/.test(m)) return `Já existe ${oque === 'conta' ? 'uma conta' : 'uma categoria desse tipo'} com esse nome.`;
  if (/23503/.test(m)) return `Não dá para excluir: ${oque === 'conta' ? 'esta conta' : 'esta categoria'} tem lançamentos. Arquive para escondê-la sem perder o histórico.`;
  return mensagemErroBanco(error);
}

/* ---------- Convites ---------- */
/** Código do convite no endereço (?convite=...), só se tiver o formato certo (43 caracteres base64url). */
function codigoDoLink(search) {
  const c = new URLSearchParams(String(search || '')).get('convite') || '';
  return /^[A-Za-z0-9_-]{43}$/.test(c) ? c : null;
}
function linkConvite(base, codigo) {
  return String(base).replace(/[?#].*$/, '') + '?convite=' + encodeURIComponent(codigo);
}

/** Texto da IA para exibir como texto puro: tira marcações de Markdown que viriam como símbolos soltos. */
function textoSimples(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?|```/gi, '')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => a ?? b)
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,;:!?)]|$)/g, '$1$2')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

if (typeof module !== 'undefined') {
  module.exports = {
    textoSimples, codigoDoLink, linkConvite, CORES, lerSaldo, saldoInicialPara, validarConta, validarCategoria, mensagemErroCadastro,
    formatarMoeda, somarSaldos, corSegura, rotuloTipoConta, mensagemErroLogin, lerValor, valorParaCampo,
    hojeISO, intervaloMes, somarMes, rotuloMes, dataValida, rotuloDia, validarLancamento, montarRegistro,
    totaisLancamentos, agruparPorDia, filtrarLancamentos, mensagemErroBanco
  };
} else {
  iniciar();
}

/* ---------- Interface ---------- */
function iniciar() {
  const $ = id => document.getElementById(id);
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  const PAGINAS = {
    inicio: { titulo: 'Início', eyebrow: 'VISÃO GERAL' },
    lancamentos: { titulo: 'Lançamentos', eyebrow: 'ENTRADAS E SAÍDAS' },
    importar: { titulo: 'Importar extrato', eyebrow: 'LANÇAMENTOS', menu: 'lancamentos' },
    assistente: { titulo: 'Assistente', eyebrow: 'ANÁLISE COM IA' },
    contas: { titulo: 'Contas', eyebrow: 'ONDE ESTÁ O DINHEIRO' },
    categorias: { titulo: 'Categorias', eyebrow: 'ORGANIZAÇÃO' }
  };
  const hoje = hojeISO();
  const estado = {
    contas: [], categorias: [], lancamentos: [],
    ano: Number(hoje.slice(0, 4)), mes: Number(hoje.slice(5, 7)),
    editando: null, excluindo: null, carregando: false, pedidoLista: 0
  };

  const mostrar = view => ['bootView', 'loginView', 'conviteView', 'appView'].forEach(v => $(v).classList.toggle('hidden', v !== view));
  const aviso = (id, texto, ok = false) => { const e = $(id); e.textContent = texto || ''; e.classList.toggle('ok', ok); };
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
  const ponto = cor => { const d = el('span', 'dot'); d.style.setProperty('--cor', corSegura(cor)); return d; };
  const contaPorId = id => estado.contas.find(c => c.id === id);
  const categoriaPorId = id => (estado.todasCategorias || estado.categorias).find(c => c.id === id); // inclui arquivadas: o histórico mantém o nome
  const opcao = (valor, texto) => { const o = document.createElement('option'); o.value = valor; o.textContent = texto; return o; };
  const sinalValor = (e, valor) => {
    e.textContent = formatarMoeda(valor);
    e.classList.toggle('neg', valor < 0); e.classList.toggle('pos', valor > 0);
  };

  function irPara(pagina) {
    if (!PAGINAS[pagina]) pagina = 'inicio';
    const noMenu = PAGINAS[pagina].menu || pagina;
    document.querySelectorAll('.nav-item[data-page]').forEach(b => {
      const ativo = b.dataset.page === noMenu;
      b.classList.toggle('active', ativo);
      if (ativo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    Object.keys(PAGINAS).forEach(p => $(p + 'Page').classList.toggle('hidden', p !== pagina));
    $('pageTitle').textContent = PAGINAS[pagina].titulo;
    $('pageEyebrow').textContent = PAGINAS[pagina].eyebrow;
    if (location.hash !== '#' + pagina) history.replaceState(null, '', '#' + pagina);
    if (pagina === 'importar') preencherContasImportacao();
  }

  /* ----- Contas, categorias e Início ----- */
  function itemConta(c, comTipo, aoClicar) {
    const li = el('li', 'list-item');
    const alvo = aoClicar ? el('button', 'list-btn') : li;
    if (aoClicar) { alvo.type = 'button'; alvo.addEventListener('click', () => aoClicar(c)); alvo.setAttribute('aria-label', `${c.nome}, saldo ${formatarMoeda(c.saldo_atual)}. Editar`); }
    const info = el('div', 'list-info');
    info.append(el('strong', null, c.nome));
    if (comTipo) info.append(el('small', null, rotuloTipoConta(c.tipo)));
    const valor = el('span', 'money', formatarMoeda(c.saldo_atual));
    if (Number(c.saldo_atual) < 0) valor.classList.add('neg');
    alvo.append(ponto(c.cor), info, valor);
    if (aoClicar) li.append(alvo);
    return li;
  }
  function chipCategoria(c) {
    const b = el('button', 'chip chip-btn');
    b.type = 'button';
    b.append(ponto(c.cor), el('span', null, c.nome));
    b.setAttribute('aria-label', `${c.nome}. Editar categoria`);
    b.addEventListener('click', () => abrirCategoria(c));
    const li = el('li'); li.append(b);
    return li;
  }
  function listaVazia(ul, texto) { ul.replaceChildren(el('li', 'list-empty', texto)); }

  function desenharBase() {
    const contas = estado.contas.filter(c => !c.arquivada);
    const arquivadas = estado.contas.filter(c => c.arquivada);
    $('saldoTotal').textContent = formatarMoeda(somarSaldos(contas));
    $('saldoResumo').textContent = contas.length === 1 ? 'em 1 conta' : `somando ${contas.length} contas`;
    $('contasQtd').textContent = String(contas.length);
    if (contas.length) {
      $('contasResumo').replaceChildren(...contas.map(c => itemConta(c, false)));
      $('contasLista').replaceChildren(...contas.map(c => itemConta(c, true, abrirConta)));
    } else {
      listaVazia($('contasResumo'), 'Nenhuma conta cadastrada.');
      listaVazia($('contasLista'), 'Nenhuma conta ativa. Toque em “+ Nova conta”.');
    }
    $('contasArquivadasBox').classList.toggle('hidden', !arquivadas.length);
    $('contasArqQtd').textContent = String(arquivadas.length);
    $('contasArquivadas').replaceChildren(...arquivadas.map(c => itemConta(c, true, abrirConta)));
    for (const [tipo, ul, qtd] of [['despesa', 'catDespesas', 'despesasQtd'], ['receita', 'catReceitas', 'receitasQtd']]) {
      const cats = estado.categorias.filter(c => c.tipo === tipo);
      $(qtd).textContent = String(cats.length);
      if (cats.length) $(ul).replaceChildren(...cats.map(chipCategoria));
      else listaVazia($(ul), 'Nenhuma categoria.');
    }
    const catArq = (estado.todasCategorias || []).filter(c => c.arquivada);
    $('catArquivadasBox').classList.toggle('hidden', !catArq.length);
    $('catArqQtd').textContent = String(catArq.length);
    $('catArquivadas').replaceChildren(...catArq.map(chipCategoria));
    // Filtros da lista
    const contaSel = $('filtroConta').value, catSel = $('filtroCategoria').value;
    $('filtroConta').replaceChildren(opcao('', 'Todas as contas'), ...contas.map(c => opcao(c.id, c.nome)));
    const grupoDesp = document.createElement('optgroup'); grupoDesp.label = 'Saídas';
    const grupoRec = document.createElement('optgroup'); grupoRec.label = 'Entradas';
    estado.categorias.forEach(c => (c.tipo === 'despesa' ? grupoDesp : grupoRec).append(opcao(c.id, c.nome)));
    $('filtroCategoria').replaceChildren(opcao('', 'Todas as categorias'), grupoDesp, grupoRec);
    $('filtroConta').value = contas.some(c => c.id === contaSel) ? contaSel : '';
    $('filtroCategoria').value = estado.categorias.some(c => c.id === catSel) ? catSel : '';
  }

  async function carregarResumoMes() {
    const { inicio, fim } = intervaloMes(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)));
    const { data, error } = await db.rpc('resumo_periodo', { p_inicio: inicio, p_fim: fim });
    if (error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    const rec = Number(r?.receitas || 0), desp = Number(r?.despesas || 0);
    $('mesEntradas').textContent = formatarMoeda(rec);
    $('mesSaidas').textContent = formatarMoeda(desp);
    sinalValor($('mesResultado'), (paraCentavos(rec) - paraCentavos(desp)) / 100);
    const aPagar = Number(r?.pendente_pagar || 0), aReceber = Number(r?.pendente_receber || 0);
    const partes = [];
    if (aPagar > 0) partes.push(`${formatarMoeda(aPagar)} a pagar`);
    if (aReceber > 0) partes.push(`${formatarMoeda(aReceber)} a receber`);
    $('mesPendente').textContent = partes.join(' · ');
  }

  /* ----- Lançamentos ----- */
  function linhaLancamento(l) {
    const linha = el('button', 'tx');
    linha.type = 'button';
    const transf = l.tipo === 'transferencia';
    const cat = transf ? null : categoriaPorId(l.categoria_id);
    const conta = contaPorId(l.conta_id);
    const ico = el('span', 'tx-ico ' + l.tipo, transf ? '⇄' : l.tipo === 'receita' ? '↓' : '↑');
    ico.setAttribute('aria-hidden', 'true');
    if (cat) ico.style.setProperty('--cor', corSegura(cat.cor));
    const info = el('span', 'tx-info');
    info.append(el('strong', null, l.descricao));
    const meta = transf
      ? `${conta?.nome || 'Conta'} → ${contaPorId(l.conta_destino_id)?.nome || 'Conta'}`
      : `${cat?.nome || 'Sem categoria'} · ${conta?.nome || 'Conta'}`;
    const sub = el('small', null, meta);
    if (!l.pago) sub.append(' ', el('span', 'tag', l.tipo === 'receita' ? 'a receber' : 'a pagar'));
    info.append(sub);
    const valor = el('span', 'money tx-valor ' + (transf ? '' : l.tipo === 'receita' ? 'pos' : 'neg'),
      (l.tipo === 'despesa' ? '−' : l.tipo === 'receita' ? '+' : '') + formatarMoeda(l.valor));
    if (!l.pago) valor.classList.add('pendente');
    linha.append(ico, info, valor);
    linha.setAttribute('aria-label', `${l.descricao}, ${l.tipo === 'despesa' ? 'saída' : l.tipo === 'receita' ? 'entrada' : 'transferência'} de ${formatarMoeda(l.valor)}. Abrir para editar`);
    linha.addEventListener('click', () => abrirFormulario(l));
    return linha;
  }

  function desenharLista() {
    const filtros = { conta: $('filtroConta').value, categoria: $('filtroCategoria').value, busca: $('filtroBusca').value };
    const visiveis = filtrarLancamentos(estado.lancamentos, filtros);
    const t = totaisLancamentos(visiveis);
    $('listaEntradas').textContent = formatarMoeda(t.entradas);
    $('listaSaidas').textContent = formatarMoeda(t.saidas);
    sinalValor($('listaResultado'), t.resultado);
    const alvo = $('listaLancamentos');
    if (!visiveis.length) {
      const vazio = el('div', 'empty-state');
      const filtrando = filtros.conta || filtros.categoria || filtros.busca.trim();
      vazio.append(el('span', 'empty-ico', '⇅'), el('h2', null, filtrando ? 'Nada encontrado' : 'Nenhum lançamento neste mês'),
        el('p', 'muted', filtrando ? 'Tente outro filtro ou limpe a busca.' : 'Toque em “+ Novo” para registrar uma entrada, saída ou transferência.'));
      vazio.firstChild.setAttribute('aria-hidden', 'true');
      alvo.replaceChildren(vazio);
      return;
    }
    const blocos = agruparPorDia(visiveis).map(([dia, itens]) => {
      const grupo = el('section', 'tx-day');
      const cab = el('div', 'tx-day-head');
      const td = totaisLancamentos(itens);
      cab.append(el('h3', null, rotuloDia(dia, hoje)));
      if (td.resultado) { const r = el('span', 'money'); sinalValor(r, td.resultado); cab.append(r); }
      grupo.append(cab, ...itens.map(linhaLancamento));
      return grupo;
    });
    alvo.replaceChildren(...blocos);
  }

  async function carregarLancamentos() {
    const pedido = ++estado.pedidoLista; // ignora respostas antigas se o mês mudar rápido
    $('mesRotulo').textContent = rotuloMes(estado.ano, estado.mes);
    $('listaLancamentos').replaceChildren(el('div', 'list-empty', 'Carregando…'));
    const { inicio, fim } = intervaloMes(estado.ano, estado.mes);
    const { data, error } = await db.from('lancamentos')
      .select('id,tipo,descricao,valor,data,conta_id,conta_destino_id,categoria_id,pago,observacoes,criado_em')
      .gte('data', inicio).lte('data', fim)
      .order('data', { ascending: false }).order('criado_em', { ascending: false })
      .limit(2000);
    if (pedido !== estado.pedidoLista) return;
    if (error) throw error;
    estado.lancamentos = data;
    desenharLista();
  }

  async function carregarDados() {
    if (estado.carregando) return;
    estado.carregando = true;
    $('refreshBtn').disabled = true;
    aviso('globalMessage', 'Atualizando…', true);
    try {
      const [contasR, catR] = await Promise.all([
        db.from('saldos_contas').select('id,nome,tipo,cor,arquivada,saldo_inicial,saldo_atual').order('nome'),
        db.from('categorias').select('id,nome,tipo,cor,arquivada').order('nome')
      ]);
      if (contasR.error) throw contasR.error;
      if (catR.error) throw catR.error;
      estado.contas = contasR.data;
      estado.todasCategorias = catR.data;
      estado.categorias = catR.data.filter(c => !c.arquivada); // só as ativas aparecem nos formulários e na importação
      desenharBase();
      preencherContasImportacao();
      await Promise.all([carregarResumoMes(), carregarLancamentos()]);
      aviso('globalMessage', '');
    } catch (e) {
      console.error(e);
      aviso('globalMessage', 'Não foi possível carregar os dados. Verifique a conexão e toque em Atualizar.');
    } finally {
      estado.carregando = false;
      $('refreshBtn').disabled = false;
    }
  }

  /* ----- Formulário ----- */
  const tipoAtual = () => document.querySelector('input[name=tipo]:checked').value;
  function prepararCamposTipo() {
    const tipo = tipoAtual();
    const transf = tipo === 'transferencia';
    $('txDestinoCampo').classList.toggle('hidden', !transf);
    $('txCategoriaCampo').classList.toggle('hidden', transf);
    $('txContaRotulo').firstChild.textContent = transf ? 'Da conta *' : 'Conta *';
    $('txPagoTexto').textContent = tipo === 'receita' ? 'Já foi recebido' : transf ? 'Já foi feita' : 'Já foi pago';
    const atual = $('txCategoria').value;
    // Ativas do tipo + a arquivada que o lançamento em edição já usa (para não obrigar a trocar).
    const cats = (estado.todasCategorias || estado.categorias).filter(c => c.tipo === tipo && (!c.arquivada || c.id === estado.editando?.categoria_id));
    $('txCategoria').replaceChildren(opcao('', 'Escolha…'), ...cats.map(c => opcao(c.id, c.arquivada ? `${c.nome} (arquivada)` : c.nome)));
    $('txCategoria').value = cats.some(c => c.id === atual) ? atual : '';
  }
  function preencherContas(select, selecionada) {
    const contas = estado.contas.filter(c => !c.arquivada || c.id === selecionada);
    select.replaceChildren(opcao('', 'Escolha…'), ...contas.map(c => opcao(c.id, c.nome)));
    select.value = selecionada || '';
  }
  function abrirFormulario(l = null) {
    if (!estado.contas.length) { aviso('globalMessage', 'Carregando contas… tente de novo em instantes.', true); return; }
    estado.editando = l;
    $('txTitulo').textContent = l ? 'Editar lançamento' : 'Novo lançamento';
    $('txExcluir').classList.toggle('hidden', !l);
    document.querySelector(`input[name=tipo][value=${l ? l.tipo : 'despesa'}]`).checked = true;
    const filtroConta = $('filtroConta').value;
    preencherContas($('txConta'), l ? l.conta_id : (filtroConta || ''));
    preencherContas($('txDestino'), l?.conta_destino_id || '');
    prepararCamposTipo();
    $('txCategoria').value = l?.categoria_id || '';
    $('txValor').value = l ? valorParaCampo(l.valor) : '';
    $('txDescricao').value = l?.descricao || '';
    // Novo lançamento: hoje, se o mês aberto for o atual; senão, o 1º dia do mês aberto.
    const mesAberto = intervaloMes(estado.ano, estado.mes);
    $('txData').value = l ? l.data : (hoje >= mesAberto.inicio && hoje <= mesAberto.fim ? hoje : mesAberto.inicio);
    $('txPago').checked = l ? !!l.pago : true;
    $('txObs').value = l?.observacoes || '';
    aviso('txMensagem', '');
    $('txSalvar').disabled = false;
    $('txDialog').showModal();
    (l ? $('txDescricao') : $('txValor')).focus();
  }
  function fecharFormulario() { $('txDialog').close(); estado.editando = null; }

  async function salvar(ev) {
    ev.preventDefault();
    const dados = {
      tipo: tipoAtual(), valor: lerValor($('txValor').value), descricao: $('txDescricao').value,
      data: $('txData').value, conta_id: $('txConta').value, conta_destino_id: $('txDestino').value,
      categoria_id: $('txCategoria').value, pago: $('txPago').checked, observacoes: $('txObs').value
    };
    const erro = validarLancamento(dados);
    if (erro) { aviso('txMensagem', erro); return; }
    const registro = montarRegistro(dados);
    $('txSalvar').disabled = true;
    aviso('txMensagem', 'Salvando…', true);
    const consulta = estado.editando
      ? db.from('lancamentos').update(registro).eq('id', estado.editando.id).select('id')
      : db.from('lancamentos').insert(registro).select('id');
    const { data, error } = await consulta;
    $('txSalvar').disabled = false;
    if (error || !data?.length) {
      console.error(error);
      aviso('txMensagem', error ? mensagemErroBanco(error) : 'Este lançamento não existe mais. Atualize a página.');
      return;
    }
    const eraNovo = !estado.editando;
    fecharFormulario();
    // Leva a lista para o mês do lançamento salvo, para você ver o resultado.
    estado.ano = Number(registro.data.slice(0, 4)); estado.mes = Number(registro.data.slice(5, 7));
    await carregarDados();
    aviso('globalMessage', eraNovo ? 'Lançamento registrado.' : 'Lançamento atualizado.', true);
  }

  /* ----- Contas e categorias ----- */
  const cad = { conta: null, categoria: null, salvando: false };
  function desenharCores(alvo, nomeGrupo, selecionada) {
    // A cor atual entra na lista mesmo se não for da paleta (ex.: laranja do Itaú), para não mudar sem querer.
    const lista = /^#[0-9a-fA-F]{6}$/.test(String(selecionada || '')) && !CORES.some(c => c.toLowerCase() === selecionada.toLowerCase()) ? [selecionada, ...CORES] : CORES;
    alvo.replaceChildren(...lista.map((cor, i) => {
      const rot = el('label', 'cor');
      const r = document.createElement('input');
      r.type = 'radio'; r.name = nomeGrupo; r.value = cor; r.checked = cor.toLowerCase() === String(selecionada).toLowerCase();
      r.setAttribute('aria-label', `Cor ${i + 1}`);
      const amostra = el('span', 'cor-amostra'); amostra.style.setProperty('--cor', cor);
      rot.append(r, amostra);
      return rot;
    }));
    if (!alvo.querySelector('input:checked')) alvo.querySelector('input').checked = true;
  }
  const corEscolhida = nomeGrupo => document.querySelector(`input[name=${nomeGrupo}]:checked`)?.value;

  function abrirConta(c = null) {
    cad.conta = c;
    $('contaTitulo').textContent = c ? 'Editar conta' : 'Nova conta';
    $('contaNome').value = c?.nome || '';
    $('contaTipo').value = c?.tipo || 'corrente';
    $('contaSaldoHoje').value = valorParaCampo(c ? Number(c.saldo_atual) : 0);
    $('contaSaldoHoje').dataset.original = $('contaSaldoHoje').value;
    $('contaSaldoAjuda').textContent = c
      ? 'Se o saldo no app do banco estiver diferente, digite o valor de lá. O Financeiro recalcula o saldo inicial para bater, sem mexer nos lançamentos. Use "-" para saldo negativo.'
      : 'Informe o saldo que aparece agora no app do banco (pode ser 0). Use "-" para saldo negativo.';
    desenharCores($('contaCores'), 'contaCor', c?.cor || CORES[estado.contas.length % CORES.length]);
    $('contaExcluir').classList.toggle('hidden', !c);
    $('contaArquivar').classList.toggle('hidden', !c);
    $('contaArquivar').textContent = c?.arquivada ? 'Desarquivar' : 'Arquivar';
    aviso('contaMensagem', '');
    $('contaDialog').showModal();
    $('contaNome').focus();
  }
  async function salvarConta(ev) {
    ev.preventDefault();
    if (cad.salvando) return;
    const c = cad.conta;
    const saldoDigitado = lerSaldo($('contaSaldoHoje').value);
    if (saldoDigitado == null) { aviso('contaMensagem', 'Informe um saldo válido, como 1.234,56, 0 ou -50,00.'); return; }
    const mudouSaldo = !c || $('contaSaldoHoje').value !== $('contaSaldoHoje').dataset.original;
    const saldoInicial = !c ? saldoDigitado : mudouSaldo ? saldoInicialPara(saldoDigitado, c.saldo_atual, c.saldo_inicial) : Number(c.saldo_inicial);
    const registro = { nome: $('contaNome').value.trim(), tipo: $('contaTipo').value, cor: corEscolhida('contaCor'), saldo_inicial: saldoInicial };
    const erro = validarConta(registro);
    if (erro) { aviso('contaMensagem', erro); return; }
    cad.salvando = true; $('contaSalvar').disabled = true;
    aviso('contaMensagem', 'Salvando…', true);
    const { error } = c
      ? await db.from('contas').update(registro).eq('id', c.id)
      : await db.from('contas').insert(registro);
    cad.salvando = false; $('contaSalvar').disabled = false;
    if (error) { aviso('contaMensagem', mensagemErroCadastro(error, 'conta')); return; }
    $('contaDialog').close();
    await carregarDados();
    aviso('globalMessage', c ? (mudouSaldo ? `Conta atualizada. Saldo de hoje: ${formatarMoeda(saldoDigitado)}.` : 'Conta atualizada.') : 'Conta criada.', true);
  }
  async function arquivarConta() {
    const c = cad.conta; if (!c) return;
    const arquivar = !c.arquivada;
    if (arquivar && !(await confirmar({ titulo: 'Arquivar conta?', botao: 'Arquivar',
      texto: `“${c.nome}” sai das listas e do saldo total, mas os lançamentos continuam no histórico.${Number(c.saldo_atual) ? ` Ela ainda tem saldo de ${formatarMoeda(c.saldo_atual)}.` : ''} Você pode desarquivar quando quiser.` }))) return;
    const { error } = await db.from('contas').update({ arquivada: arquivar }).eq('id', c.id);
    if (error) { aviso('contaMensagem', mensagemErroCadastro(error, 'conta')); return; }
    $('contaDialog').close();
    await carregarDados();
    aviso('globalMessage', arquivar ? 'Conta arquivada.' : 'Conta desarquivada.', true);
  }
  async function excluirConta() {
    const c = cad.conta; if (!c) return;
    if (!(await confirmar({ titulo: 'Excluir conta?', texto: `“${c.nome}” será excluída. Só é possível excluir contas sem lançamentos. Esta ação não pode ser desfeita.` }))) return;
    const { data, error } = await db.from('contas').delete().eq('id', c.id).select('id');
    if (error) { aviso('contaMensagem', mensagemErroCadastro(error, 'conta')); return; }
    $('contaDialog').close();
    await carregarDados();
    aviso('globalMessage', data?.length ? 'Conta excluída.' : 'A conta já tinha sido excluída.', true);
  }

  function abrirCategoria(c = null, tipo = 'despesa') {
    cad.categoria = c;
    $('catTitulo').textContent = c ? 'Editar categoria' : 'Nova categoria';
    document.querySelector(`input[name=catTipo][value=${c?.tipo || tipo}]`).checked = true;
    // O tipo de uma categoria existente não muda: lançamentos dependem dele (regra do banco).
    document.querySelectorAll('input[name=catTipo]').forEach(r => { r.disabled = !!c; });
    $('catNome').value = c?.nome || '';
    desenharCores($('catCores'), 'catCor', c?.cor || CORES[(estado.todasCategorias || []).length % CORES.length]);
    $('catExcluir').classList.toggle('hidden', !c);
    $('catArquivar').classList.toggle('hidden', !c);
    $('catArquivar').textContent = c?.arquivada ? 'Desarquivar' : 'Arquivar';
    aviso('catMensagem', '');
    $('catDialog').showModal();
    $('catNome').focus();
  }
  async function salvarCategoria(ev) {
    ev.preventDefault();
    if (cad.salvando) return;
    const c = cad.categoria;
    const registro = { nome: $('catNome').value.trim(), cor: corEscolhida('catCor'), tipo: c ? c.tipo : document.querySelector('input[name=catTipo]:checked').value };
    const erro = validarCategoria(registro);
    if (erro) { aviso('catMensagem', erro); return; }
    cad.salvando = true; $('catSalvar').disabled = true;
    aviso('catMensagem', 'Salvando…', true);
    const { error } = c
      ? await db.from('categorias').update({ nome: registro.nome, cor: registro.cor }).eq('id', c.id)
      : await db.from('categorias').insert(registro);
    cad.salvando = false; $('catSalvar').disabled = false;
    if (error) { aviso('catMensagem', mensagemErroCadastro(error, 'categoria')); return; }
    $('catDialog').close();
    await carregarDados();
    aviso('globalMessage', c ? 'Categoria atualizada.' : 'Categoria criada.', true);
  }
  async function arquivarCategoria() {
    const c = cad.categoria; if (!c) return;
    const arquivar = !c.arquivada;
    if (arquivar && !(await confirmar({ titulo: 'Arquivar categoria?', botao: 'Arquivar',
      texto: `“${c.nome}” não aparece mais para novos lançamentos nem na importação. Os lançamentos antigos continuam com ela.` }))) return;
    const { error } = await db.from('categorias').update({ arquivada: arquivar }).eq('id', c.id);
    if (error) { aviso('catMensagem', mensagemErroCadastro(error, 'categoria')); return; }
    $('catDialog').close();
    await carregarDados();
    aviso('globalMessage', arquivar ? 'Categoria arquivada.' : 'Categoria desarquivada.', true);
  }
  async function excluirCategoria() {
    const c = cad.categoria; if (!c) return;
    if (!(await confirmar({ titulo: 'Excluir categoria?', texto: `“${c.nome}” será excluída. Só é possível excluir categorias sem lançamentos. Esta ação não pode ser desfeita.` }))) return;
    const { data, error } = await db.from('categorias').delete().eq('id', c.id).select('id');
    if (error) { aviso('catMensagem', mensagemErroCadastro(error, 'categoria')); return; }
    $('catDialog').close();
    await carregarDados();
    aviso('globalMessage', data?.length ? 'Categoria excluída.' : 'A categoria já tinha sido excluída.', true);
  }

  /** Janela de confirmação genérica. Devolve true se a pessoa confirmar. */
  function confirmar({ titulo, texto, botao = 'Excluir' }) {
    return new Promise(resolve => {
      $('confirmTitulo').textContent = titulo;
      $('confirmTexto').textContent = texto;
      $('confirmSim').textContent = botao;
      const fim = valor => { $('confirmSim').onclick = null; $('confirmNao').onclick = null; $('confirmDialog').onclose = null; if ($('confirmDialog').open) $('confirmDialog').close(); resolve(valor); };
      $('confirmSim').onclick = () => fim(true);
      $('confirmNao').onclick = () => fim(false);
      $('confirmDialog').onclose = () => fim(false);
      $('confirmDialog').showModal();
      $('confirmNao').focus();
    });
  }

  async function pedirExclusao() {
    const l = estado.editando;
    if (!l) return;
    const ok = await confirmar({ titulo: 'Excluir lançamento?', texto: `“${l.descricao}”, ${formatarMoeda(l.valor)}. Esta ação não pode ser desfeita.` });
    if (!ok) return;
    $('txExcluir').disabled = true;
    const { data, error } = await db.from('lancamentos').delete().eq('id', l.id).select('id');
    $('txExcluir').disabled = false;
    if (error) { aviso('txMensagem', mensagemErroBanco(error)); return; }
    fecharFormulario();
    await carregarDados();
    aviso('globalMessage', data?.length ? 'Lançamento excluído.' : 'O lançamento já tinha sido excluído.', true);
  }

  function mudarMes(delta) {
    Object.assign(estado, somarMes(estado.ano, estado.mes, delta));
    carregarLancamentos().catch(e => { console.error(e); aviso('globalMessage', 'Não foi possível carregar os lançamentos.'); });
  }

  /* ----- Importação de extrato ----- */
  const imp = { linhas: [], extrato: null, contaId: '', arquivo: null, gravando: false, leitura: 0 };
  const TAMANHO_MAXIMO = 5 * 1024 * 1024;
  const formatarData = iso => iso.split('-').reverse().join('/');

  /** Lista de contas da importação. Chamada ao abrir a página (por botão, link ou ao reabrir o app)
      e sempre que as contas carregam, para nunca ficar vazia. Mantém a conta já escolhida. */
  function preencherContasImportacao() {
    const contas = estado.contas.filter(c => !c.arquivada);
    const atual = $('impConta').value || $('filtroConta').value;
    $('impConta').replaceChildren(opcao('', contas.length ? 'Escolha a conta…' : estado.carregando ? 'Carregando contas…' : 'Nenhuma conta ativa'), ...contas.map(c => opcao(c.id, c.nome)));
    $('impConta').value = contas.some(c => c.id === atual) ? atual : '';
  }
  function abrirImportar() { irPara('importar'); }
  function limparImportacao() {
    Object.assign(imp, { linhas: [], extrato: null, contaId: '', arquivo: null });
    imp.leitura++;
    $('impArquivo').value = '';
    $('impArquivoNome').textContent = 'Escolher arquivo OFX ou CSV';
    $('impPrevia').classList.add('hidden');
    $('impLista').replaceChildren();
    aviso('impMensagem', '');
  }

  async function lerArquivo(arquivo) {
    const leitura = ++imp.leitura;
    $('impPrevia').classList.add('hidden');
    if (!arquivo) return;
    imp.arquivo = arquivo;
    $('impArquivoNome').textContent = arquivo.name;
    const contaId = $('impConta').value;
    if (!contaId) { aviso('impMensagem', 'Agora escolha a conta deste extrato.'); return; }
    if (arquivo.size > TAMANHO_MAXIMO) { aviso('impMensagem', 'Arquivo grande demais (máximo 5 MB). Exporte um período menor.'); return; }
    aviso('impMensagem', 'Lendo o arquivo…', true);
    try {
      const texto = Importar.decodificar(new Uint8Array(await arquivo.arrayBuffer()));
      const extrato = Importar.lerExtrato(texto, arquivo.name);
      if (extrato.tipoExtrato === 'cartao') {
        aviso('impMensagem', 'Este arquivo parece ser uma fatura de cartão de crédito. O cartão terá tratamento próprio na próxima etapa, para não contar as compras em dobro com o pagamento da fatura. Por enquanto, importe o extrato da conta.');
        return;
      }
      if (!extrato.movimentos.length) { aviso('impMensagem', 'Não encontrei movimentos neste arquivo.'); return; }
      const datas = extrato.movimentos.map(m => m.data).sort();
      // O que já existe nesta conta no período (para não duplicar) e o histórico (para sugerir categorias).
      const [existR, histR] = await Promise.all([
        db.from('lancamentos').select('data,tipo,valor,id_externo').eq('conta_id', contaId)
          .gte('data', datas[0]).lte('data', datas[datas.length - 1]).limit(10000),
        db.from('lancamentos').select('descricao,tipo,categoria_id').not('categoria_id', 'is', null)
          .order('data', { ascending: false }).limit(1500)
      ]);
      if (existR.error) throw existR.error;
      if (histR.error) throw histR.error;
      if (leitura !== imp.leitura) return; // outro arquivo foi escolhido enquanto este carregava
      imp.extrato = extrato;
      imp.contaId = contaId;
      imp.linhas = Importar.prepararPrevia(extrato, {
        categorias: estado.categorias,
        historico: Importar.montarHistorico(histR.data),
        idsExistentes: new Set(existR.data.map(l => l.id_externo).filter(Boolean)),
        existentes: existR.data
      });
      aviso('impMensagem', '');
      desenharPrevia();
      $('impPrevia').classList.remove('hidden');
      $('impPrevia').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (leitura !== imp.leitura) return;
      if (!e.codigo) console.error(e); // erros com código são esperados e explicados na tela
      aviso('impMensagem', e.codigo ? e.message : (e.message && /fetch|network/i.test(e.message) ? mensagemErroBanco(e) : 'Não consegui ler este arquivo. Confira se é um extrato em OFX ou CSV.'));
    }
  }

  const ROTULO_SITUACAO = { importada: 'já importado', parecida: 'parece já lançado à mão' };
  function linhaPrevia(l, i) {
    const item = el('div', 'imp-row' + (l.incluir ? '' : ' off'));
    const marca = document.createElement('input');
    marca.type = 'checkbox'; marca.checked = l.incluir;
    marca.setAttribute('aria-label', `Importar ${l.descricao}, ${formatarMoeda(l.valor)}`);
    marca.addEventListener('change', () => { l.incluir = marca.checked; item.classList.toggle('off', !l.incluir); desenharResumo(); });
    const info = el('div', 'imp-info');
    const topo = el('div', 'imp-top');
    topo.append(el('strong', null, l.descricao));
    const valor = el('span', 'money ' + (l.tipo === 'receita' ? 'pos' : 'neg'), (l.tipo === 'receita' ? '+' : '−') + formatarMoeda(l.valor));
    topo.append(valor);
    const baixo = el('div', 'imp-bottom');
    baixo.append(el('small', null, formatarData(l.data)));
    if (ROTULO_SITUACAO[l.situacao]) baixo.append(el('span', 'tag', ROTULO_SITUACAO[l.situacao]));
    const sel = document.createElement('select');
    sel.className = 'imp-cat' + (l.motivo === 'padrao' ? ' sem-sugestao' : '');
    sel.setAttribute('aria-label', `Categoria de ${l.descricao}`);
    sel.append(opcao('', 'Sem categoria'), ...estado.categorias.filter(c => c.tipo === l.tipo).map(c => opcao(c.id, c.nome)));
    sel.value = l.categoria_id || '';
    sel.addEventListener('change', () => { l.categoria_id = sel.value; sel.classList.remove('sem-sugestao'); });
    baixo.append(sel);
    info.append(topo, baixo);
    item.append(marca, info);
    item.dataset.i = String(i);
    return item;
  }
  function desenharResumo() {
    const r = Importar.resumoPrevia(imp.linhas);
    $('impResumo').textContent = r.incluidas === 1 ? '1 lançamento marcado' : `${r.incluidas} lançamentos marcados`;
    $('impResumoValores').textContent = `Entradas ${formatarMoeda(r.entradas)} · Saídas ${formatarMoeda(r.saidas)}`;
    $('impConfirmar').disabled = r.incluidas === 0 || imp.gravando;
    $('impConfirmar').textContent = r.incluidas ? `Importar ${r.incluidas}` : 'Importar';
  }
  function desenharPrevia() {
    const r = Importar.resumoPrevia(imp.linhas);
    const conta = contaPorId(imp.contaId)?.nome || 'conta';
    $('impInfo').textContent = `${imp.extrato.formato} · ${formatarData(r.inicio)} a ${formatarData(r.fim)} · ${r.total} movimentos para ${conta}.`;
    const avisos = [];
    if (r.importadas) avisos.push(`${r.importadas} já ${r.importadas === 1 ? 'foi importado' : 'foram importados'} antes e ${r.importadas === 1 ? 'ficou desmarcado' : 'ficaram desmarcados'}.`);
    if (r.parecidas) avisos.push(`${r.parecidas} ${r.parecidas === 1 ? 'tem' : 'têm'} a mesma data e valor de um lançamento que você fez à mão. Desmarquei para não contar em dobro; marque se for outro gasto.`);
    const semCat = imp.linhas.filter(l => l.motivo === 'padrao').length;
    if (semCat) avisos.push(`${semCat} sem categoria reconhecida ${semCat === 1 ? 'foi' : 'foram'} para "Outras". Ajuste se quiser; o app aprende para as próximas importações.`);
    const desc = imp.extrato.descartados;
    if (desc.saldo) avisos.push(`${desc.saldo} ${desc.saldo === 1 ? 'linha de saldo foi ignorada' : 'linhas de saldo foram ignoradas'}.`);
    $('impAvisos').replaceChildren(...avisos.map(t => el('p', 'note', t)));
    $('impLista').replaceChildren(...imp.linhas.map(linhaPrevia));
    desenharResumo();
  }
  function marcarTodas(valor) {
    imp.linhas.forEach(l => { l.incluir = valor ? l.situacao === 'nova' : false; });
    desenharPrevia();
  }

  async function confirmarImportacao() {
    const registros = Importar.registrosParaGravar(imp.linhas, imp.contaId);
    if (!registros.length || imp.gravando) return;
    imp.gravando = true;
    $('impConfirmar').disabled = true;
    $('impCancelar').disabled = true;
    let gravados = 0;
    try {
      // Em lotes; se o mesmo movimento já existir (outra aba, outro aparelho), o banco ignora em vez de duplicar.
      for (let i = 0; i < registros.length; i += 400) {
        const lote = registros.slice(i, i + 400);
        aviso('impMensagem', `Importando… ${Math.min(i + lote.length, registros.length)} de ${registros.length}`, true);
        const { data, error } = await db.from('lancamentos')
          .upsert(lote, { onConflict: 'usuario_id,conta_id,id_externo', ignoreDuplicates: true })
          .select('id');
        if (error) throw error;
        gravados += data.length;
      }
      const ignorados = registros.length - gravados;
      const ultima = imp.linhas.filter(l => l.incluir).map(l => l.data).sort().pop();
      limparImportacao();
      estado.ano = Number(ultima.slice(0, 4)); estado.mes = Number(ultima.slice(5, 7));
      irPara('lancamentos');
      await carregarDados();
      aviso('globalMessage', `${gravados} ${gravados === 1 ? 'lançamento importado' : 'lançamentos importados'}` +
        (ignorados ? ` (${ignorados} já existia${ignorados === 1 ? '' : 'm'} e não foi duplicado${ignorados === 1 ? '' : 's'}).` : '.'), true);
    } catch (e) {
      console.error(e);
      aviso('impMensagem', (gravados ? `${gravados} foram gravados antes do erro. Ao tentar de novo, eles não serão duplicados. ` : '') + mensagemErroBanco(e));
      if (gravados) await carregarDados();
    } finally {
      imp.gravando = false;
      $('impCancelar').disabled = false;
      if (imp.linhas.length) desenharResumo();
    }
  }

  /* ----- Assistente (IA) ----- */
  const ag = { ano: Number(hoje.slice(0, 4)), mes: Number(hoje.slice(5, 7)), conversa: [], ocupado: false };
  const TIPO_DESTAQUE = { alerta: ['!', 'Atenção'], economia: ['$', 'Economia'], positivo: ['✓', 'Ponto positivo'], dica: ['i', 'Dica'] };

  async function chamarAgente(corpo) {
    const { data, error } = await db.functions.invoke('agente', { body: corpo });
    if (!error) return data;
    let msg = 'Não foi possível falar com o assistente. Verifique a conexão e tente de novo.';
    try { const r = await error.context?.json?.(); if (r?.erro) msg = r.erro; } catch (_) { /* resposta sem JSON */ }
    throw new Error(msg);
  }
  function mostrarMesAgente() {
    $('agMesRotulo').textContent = rotuloMes(ag.ano, ag.mes);
    const atual = ag.ano * 12 + ag.mes >= Number(hoje.slice(0, 4)) * 12 + Number(hoje.slice(5, 7));
    $('agMesSeguinte').disabled = atual;
  }
  function cartaoDestaque(d) {
    const [ico, rotulo] = TIPO_DESTAQUE[d.tipo] || TIPO_DESTAQUE.dica;
    const card = el('article', 'ag-card ' + d.tipo);
    const topo = el('div', 'ag-card-top');
    const i = el('span', 'ag-ico', ico); i.setAttribute('aria-hidden', 'true');
    topo.append(i, el('span', 'ag-tipo', rotulo));
    if (d.prioridade === 'alta') topo.append(el('span', 'tag tag-alta', 'prioridade alta'));
    card.append(topo, el('h3', null, textoSimples(d.titulo)), el('p', null, textoSimples(d.detalhe)));
    if (d.economia_mensal_estimada) card.append(el('p', 'ag-economia', `Economia estimada: ${formatarMoeda(d.economia_mensal_estimada)} por mês`));
    return card;
  }
  async function analisarMes() {
    if (ag.ocupado) return;
    ag.ocupado = true;
    $('agAnalisar').disabled = true;
    $('agResultado').classList.add('hidden');
    aviso('agMensagem', 'Analisando seus lançamentos… isso leva uns 15 segundos.', true);
    try {
      const mes = `${ag.ano}-${String(ag.mes).padStart(2, '0')}`;
      const r = await chamarAgente({ modo: 'relatorio', mes });
      $('agResumo').textContent = textoSimples(r.relatorio.resumo);
      $('agDestaques').replaceChildren(...r.relatorio.destaques.map(cartaoDestaque));
      $('agResultado').classList.remove('hidden');
      aviso('agMensagem', '');
    } catch (e) {
      aviso('agMensagem', e.message);
    } finally {
      ag.ocupado = false;
      $('agAnalisar').disabled = false;
    }
  }
  function bolha(papel, texto) {
    const b = el('div', 'msg ' + (papel === 'user' ? 'msg-eu' : papel === 'erro' ? 'msg-erro' : 'msg-ia'), papel === 'user' ? texto : textoSimples(texto));
    $('agChat').append(b);
    b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return b;
  }
  async function perguntar(texto) {
    texto = String(texto || '').trim();
    if (!texto || ag.ocupado) return;
    ag.ocupado = true;
    $('agEnviar').disabled = true;
    $('agSugestoes').classList.add('hidden');
    $('agLimpar').classList.remove('hidden');
    $('agPergunta').value = '';
    bolha('user', texto);
    ag.conversa.push({ role: 'user', content: texto });
    const pensando = bolha('ia', 'Consultando seus lançamentos…');
    pensando.classList.add('pensando');
    try {
      const r = await chamarAgente({ modo: 'chat', mensagens: ag.conversa.slice(-12) });
      pensando.remove();
      bolha('ia', r.resposta);
      ag.conversa.push({ role: 'assistant', content: r.resposta });
    } catch (e) {
      pensando.remove();
      ag.conversa.pop(); // a pergunta sem resposta não entra no histórico
      bolha('erro', e.message);
    } finally {
      ag.ocupado = false;
      $('agEnviar').disabled = false;
      $('agPergunta').focus();
    }
  }
  function limparConversa() {
    ag.conversa = [];
    $('agChat').replaceChildren();
    $('agSugestoes').classList.remove('hidden');
    $('agLimpar').classList.add('hidden');
  }

  /* ----- App instalável ----- */
  function prepararInstalacao() {
    const guardado = chave => { try { return localStorage.getItem(chave); } catch (_) { return null; } };
    const guardar = (chave, v) => { try { localStorage.setItem(chave, v); } catch (_) { /* navegador sem armazenamento */ } };
    const instalado = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const iPhone = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
    let pedido = null;
    const mostrar = (texto, comBotao) => {
      if (instalado() || guardado('instalarDispensado')) return;
      if (texto) $('instalarTexto').textContent = texto;
      $('instalarBtn').classList.toggle('hidden', !comBotao);
      $('instalarAviso').classList.remove('hidden');
    };
    const esconder = () => $('instalarAviso').classList.add('hidden');
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker não registrado:', e?.message));
    }
    window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); pedido = ev; mostrar(null, true); });
    window.addEventListener('appinstalled', () => { pedido = null; esconder(); });
    if (iPhone) mostrar('No iPhone: toque em Compartilhar (□↑) e depois em "Adicionar à Tela de Início".', false);
    $('instalarBtn').addEventListener('click', async () => {
      if (!pedido) return;
      pedido.prompt();
      const { outcome } = await pedido.userChoice;
      pedido = null;
      if (outcome === 'accepted') esconder();
    });
    $('instalarFechar').addEventListener('click', () => { guardar('instalarDispensado', '1'); esconder(); });
  }
  prepararInstalacao();

  /* ----- Convites: painel do administrador ----- */
  const SITUACAO_CONVITE = { pendente: ['Aguardando', 'tag'], usado: ['Usado', 'tag tag-ok'], cancelado: ['Cancelado', 'tag tag-off'], vencido: ['Vencido', 'tag tag-off'], em_uso: ['Em uso agora', 'tag'] };
  const fmtDataHora = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  async function carregarConvites() {
    const { data: admin, error } = await db.rpc('sou_administrador');
    $('convitesPainel').classList.toggle('hidden', error || admin !== true);
    if (error || admin !== true) return;
    const { data, error: e2 } = await db.rpc('listar_convites');
    if (e2) { aviso('convitesMensagem', 'Não foi possível carregar os convites.'); return; }
    const itens = data.map(c => {
      const li = el('li', 'list-item');
      const info = el('div', 'list-info');
      info.append(el('strong', null, c.rotulo || 'Convite sem apelido'));
      info.append(el('small', null, c.situacao === 'usado' ? `Usado em ${fmtDataHora(c.usado_em)}` : `Criado em ${fmtDataHora(c.criado_em)} · vale até ${fmtDataHora(c.expira_em)}`));
      const [rot, cls] = SITUACAO_CONVITE[c.situacao] || ['—', 'tag'];
      li.append(info, el('span', cls, rot));
      if (c.situacao === 'pendente') {
        const b = el('button', 'ghost', 'Cancelar'); b.type = 'button';
        b.addEventListener('click', async () => {
          if (!(await confirmar({ titulo: 'Cancelar convite?', botao: 'Cancelar convite', texto: `O link ${c.rotulo ? `para ${c.rotulo} ` : ''}para de funcionar na hora.` }))) return;
          const { error: e3 } = await db.rpc('cancelar_convite', { p_id: c.id });
          aviso('convitesMensagem', e3 ? mensagemErroBanco(e3) : 'Convite cancelado.', !e3);
          carregarConvites();
        });
        li.append(b);
      }
      return li;
    });
    if (itens.length) $('convitesLista').replaceChildren(...itens); else listaVazia($('convitesLista'), 'Nenhum convite gerado ainda.');
  }
  async function gerarConvite(ev) {
    ev.preventDefault();
    $('conviteGerar').disabled = true;
    aviso('convitesMensagem', 'Gerando…', true);
    const { data, error } = await db.rpc('criar_convite', { p_rotulo: $('conviteRotulo').value.trim() || null });
    $('conviteGerar').disabled = false;
    if (error || !data?.[0]?.codigo) {
      const m = String(error?.message || '');
      aviso('convitesMensagem', /pendentes|caracteres|administrador/.test(m) ? m : mensagemErroBanco(error));
      return;
    }
    $('conviteLink').value = linkConvite(location.origin + location.pathname, data[0].codigo);
    $('conviteGerado').classList.remove('hidden');
    $('conviteCompartilhar').classList.toggle('hidden', !navigator.share);
    $('conviteRotulo').value = '';
    aviso('convitesMensagem', '');
    $('conviteLink').select();
    carregarConvites();
  }
  async function copiarConvite() {
    try { await navigator.clipboard.writeText($('conviteLink').value); aviso('convitesMensagem', 'Link copiado. Agora é só colar na conversa com a pessoa.', true); }
    catch (_) { $('conviteLink').select(); aviso('convitesMensagem', 'Selecione o link e copie (Ctrl+C).', true); }
  }

  /* ----- Convites: tela do convidado ----- */
  const codigoConvite = codigoDoLink(location.search);
  const conviteAtivo = { ligado: !!new URLSearchParams(location.search).get('convite') };
  async function chamarCadastro(corpo) {
    const { data, error } = await db.functions.invoke('registrar-convite', { body: corpo });
    if (!error) return data;
    let r = null; try { r = await error.context?.json?.(); } catch (_) { /* sem JSON */ }
    const e = new Error(r?.erro || 'Não foi possível falar com o servidor. Verifique a conexão.'); e.codigo = r?.codigo_erro; throw e;
  }
  function conviteInvalido(msg) {
    $('conviteCampos').classList.add('hidden');
    $('conviteTitulo').textContent = 'Convite indisponível';
    $('conviteSub').textContent = '';
    aviso('conviteMensagem', msg);
    $('conviteIrLogin').classList.remove('hidden');
  }
  async function abrirConvite(sessao) {
    mostrar('conviteView');
    if (!codigoConvite) { conviteInvalido('Este link de convite está incompleto. Confira se copiou o link inteiro.'); return; }
    if (sessao) {
      $('conviteCampos').classList.add('hidden');
      aviso('conviteMensagem', `Este aparelho já está conectado como ${sessao.user.email}. Para criar outro acesso pelo convite, saia dessa conta primeiro.`);
      $('conviteIrLogin').textContent = 'Sair desta conta e continuar';
      $('conviteIrLogin').classList.remove('hidden');
      $('conviteIrLogin').onclick = async () => { await db.auth.signOut({ scope: 'local' }); location.reload(); };
      return;
    }
    aviso('conviteMensagem', 'Conferindo o convite…', true);
    try {
      const r = await chamarCadastro({ acao: 'verificar', codigo: codigoConvite });
      $('conviteTitulo').textContent = r.rotulo ? `${r.rotulo}, você recebeu um convite` : 'Você recebeu um convite';
      aviso('conviteMensagem', '');
      $('conviteEmail').focus();
    } catch (e) { conviteInvalido(e.message); }
  }
  async function concluirConvite(ev) {
    ev.preventDefault();
    const email = $('conviteEmail').value.trim(), senha = $('conviteSenha').value;
    if (!email) { aviso('conviteMensagem', 'Informe seu e-mail.'); return; }
    if (senha.length < 10) { aviso('conviteMensagem', 'A senha precisa ter pelo menos 10 caracteres.'); return; }
    if (senha !== $('conviteSenha2').value) { aviso('conviteMensagem', 'As duas senhas não são iguais.'); return; }
    $('conviteBtn').disabled = true;
    aviso('conviteMensagem', 'Criando seu acesso…', true);
    try {
      await chamarCadastro({ acao: 'cadastrar', codigo: codigoConvite, email, senha });
      aviso('conviteMensagem', 'Acesso criado! Entrando…', true);
      conviteAtivo.ligado = false;
      history.replaceState(null, '', location.pathname + '#inicio'); // tira o código do endereço
      const { error } = await db.auth.signInWithPassword({ email, password: senha });
      if (error) { mostrar('loginView'); $('email').value = email; aviso('loginMessage', 'Acesso criado. Entre com sua senha.', true); }
    } catch (e) {
      aviso('conviteMensagem', e.message);
      if (e.codigo === 'expirado' || e.codigo === 'invalido') conviteInvalido(e.message);
    } finally { $('conviteBtn').disabled = false; }
  }

  /* ----- Sessão ----- */
  function entrarNoApp(session) {
    $('userEmail').textContent = session.user.email || '';
    mostrar('appView');
    irPara(location.hash.slice(1));
    carregarDados();
    carregarConvites().catch(() => $('convitesPainel').classList.add('hidden'));
  }
  function sairDoApp() {
    if ($('txDialog').open) $('txDialog').close();
    if ($('confirmDialog').open) $('confirmDialog').close();
    ['contaDialog', 'catDialog'].forEach(id => { if ($(id).open) $(id).close(); });
    Object.assign(estado, { contas: [], categorias: [], lancamentos: [], editando: null, excluindo: null });
    limparImportacao();
    limparConversa();
    $('agResultado').classList.add('hidden');
    $('agDestaques').replaceChildren();
    ['saldoTotal', 'mesEntradas', 'mesSaidas', 'mesResultado'].forEach(id => { $(id).textContent = '—'; });
    ['contasResumo', 'contasLista', 'catDespesas', 'catReceitas', 'listaLancamentos'].forEach(id => $(id).replaceChildren());
    $('password').value = '';
    mostrar('loginView');
  }

  $('loginForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('email').value.trim(), senha = $('password').value;
    if (!email || !senha) { aviso('loginMessage', 'Informe e-mail e senha.'); return; }
    $('loginBtn').disabled = true;
    aviso('loginMessage', 'Entrando…', true);
    const { error } = await db.auth.signInWithPassword({ email, password: senha });
    $('loginBtn').disabled = false;
    if (error) aviso('loginMessage', mensagemErroLogin(error));
    else aviso('loginMessage', '');
  });
  // "local": sai só deste aparelho; os outros continuam conectados.
  $('logoutBtn').addEventListener('click', async () => { await db.auth.signOut({ scope: 'local' }); });
  $('refreshBtn').addEventListener('click', carregarDados);
  $('novoBtn').addEventListener('click', () => abrirFormulario());
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.addEventListener('click', () => irPara(b.dataset.page)));
  document.querySelectorAll('input[name=tipo]').forEach(r => r.addEventListener('change', prepararCamposTipo));
  $('txForm').addEventListener('submit', salvar);
  $('txFechar').addEventListener('click', fecharFormulario);
  $('txCancelar').addEventListener('click', fecharFormulario);
  $('txExcluir').addEventListener('click', pedirExclusao);
  $('txValor').addEventListener('blur', () => { const v = lerValor($('txValor').value); if (v != null) $('txValor').value = valorParaCampo(v); });
  $('mesAnterior').addEventListener('click', () => mudarMes(-1));
  $('mesSeguinte').addEventListener('click', () => mudarMes(1));
  ['filtroConta', 'filtroCategoria'].forEach(id => $(id).addEventListener('change', desenharLista));
  $('filtroBusca').addEventListener('input', desenharLista);
  $('txDialog').addEventListener('close', () => { estado.editando = null; });
  $('abrirImportar').addEventListener('click', abrirImportar);
  $('novaContaBtn').addEventListener('click', () => abrirConta());
  $('contaForm').addEventListener('submit', salvarConta);
  ['contaFechar', 'contaCancelar'].forEach(id => $(id).addEventListener('click', () => $('contaDialog').close()));
  $('contaArquivar').addEventListener('click', arquivarConta);
  $('contaExcluir').addEventListener('click', excluirConta);
  $('contaSaldoHoje').addEventListener('blur', () => { const v = lerSaldo($('contaSaldoHoje').value); if (v != null && $('contaSaldoHoje').value !== $('contaSaldoHoje').dataset.original) $('contaSaldoHoje').value = valorParaCampo(v); });
  document.querySelectorAll('.nova-cat').forEach(b => b.addEventListener('click', () => abrirCategoria(null, b.dataset.tipo)));
  $('catForm').addEventListener('submit', salvarCategoria);
  ['catFechar', 'catCancelar'].forEach(id => $(id).addEventListener('click', () => $('catDialog').close()));
  $('catArquivar').addEventListener('click', arquivarCategoria);
  $('catExcluir').addEventListener('click', excluirCategoria);
  mostrarMesAgente();
  $('agMesAnterior').addEventListener('click', () => { Object.assign(ag, somarMes(ag.ano, ag.mes, -1)); mostrarMesAgente(); $('agResultado').classList.add('hidden'); });
  $('agMesSeguinte').addEventListener('click', () => { Object.assign(ag, somarMes(ag.ano, ag.mes, 1)); mostrarMesAgente(); $('agResultado').classList.add('hidden'); });
  $('agAnalisar').addEventListener('click', analisarMes);
  $('agForm').addEventListener('submit', ev => { ev.preventDefault(); perguntar($('agPergunta').value); });
  $('agPergunta').addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); perguntar($('agPergunta').value); } });
  document.querySelectorAll('#agSugestoes .chip-btn').forEach(b => b.addEventListener('click', () => perguntar(b.textContent)));
  $('agLimpar').addEventListener('click', limparConversa);
  $('voltarLancamentos').addEventListener('click', () => { limparImportacao(); irPara('lancamentos'); });
  $('impCancelar').addEventListener('click', () => { limparImportacao(); irPara('lancamentos'); });
  $('impArquivo').addEventListener('change', () => lerArquivo($('impArquivo').files[0]));
  $('impConta').addEventListener('change', () => { if (imp.arquivo) lerArquivo(imp.arquivo); });
  $('impMarcar').addEventListener('click', () => marcarTodas(true));
  $('impDesmarcar').addEventListener('click', () => marcarTodas(false));
  $('impConfirmar').addEventListener('click', confirmarImportacao);
  const zona = $('impDrop');
  ['dragenter', 'dragover'].forEach(t => zona.addEventListener(t, ev => { ev.preventDefault(); zona.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zona.addEventListener(t, () => zona.classList.remove('over')));
  zona.addEventListener('drop', ev => { ev.preventDefault(); const f = ev.dataTransfer?.files?.[0]; if (f) lerArquivo(f); });

  let sessaoAtual = null;
  $('conviteForm').addEventListener('submit', concluirConvite);
  $('conviteIrLogin').addEventListener('click', () => { if ($('conviteIrLogin').onclick) return; conviteAtivo.ligado = false; history.replaceState(null, '', location.pathname); mostrar('loginView'); });
  $('conviteNovoForm').addEventListener('submit', gerarConvite);
  $('conviteCopiar').addEventListener('click', copiarConvite);
  $('conviteCompartilhar').addEventListener('click', () => navigator.share?.({ title: 'Convite para o Financeiro', text: 'Crie seu acesso ao Financeiro por este link (vale por 48 horas):', url: $('conviteLink').value }).catch(() => {}));

  db.auth.onAuthStateChange((evento, session) => {
    // Link de convite aberto: mostra a tela de cadastro em vez do app.
    if (conviteAtivo.ligado) { if (evento === 'INITIAL_SESSION') abrirConvite(session); sessaoAtual = session; return; }
    // Evita recarregar tudo a cada renovação automática do token.
    if (session && (!sessaoAtual || evento === 'SIGNED_IN' && sessaoAtual.user.id !== session.user.id)) entrarNoApp(session);
    if (!session) sairDoApp();
    sessaoAtual = session;
  });
}
