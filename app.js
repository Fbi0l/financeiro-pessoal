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

if (typeof module !== 'undefined') {
  module.exports = {
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
    contas: { titulo: 'Contas', eyebrow: 'ONDE ESTÁ O DINHEIRO' },
    categorias: { titulo: 'Categorias', eyebrow: 'ORGANIZAÇÃO' }
  };
  const hoje = hojeISO();
  const estado = {
    contas: [], categorias: [], lancamentos: [],
    ano: Number(hoje.slice(0, 4)), mes: Number(hoje.slice(5, 7)),
    editando: null, excluindo: null, carregando: false, pedidoLista: 0
  };

  const mostrar = view => ['bootView', 'loginView', 'appView'].forEach(v => $(v).classList.toggle('hidden', v !== view));
  const aviso = (id, texto, ok = false) => { const e = $(id); e.textContent = texto || ''; e.classList.toggle('ok', ok); };
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
  const ponto = cor => { const d = el('span', 'dot'); d.style.setProperty('--cor', corSegura(cor)); return d; };
  const contaPorId = id => estado.contas.find(c => c.id === id);
  const categoriaPorId = id => estado.categorias.find(c => c.id === id);
  const opcao = (valor, texto) => { const o = document.createElement('option'); o.value = valor; o.textContent = texto; return o; };
  const sinalValor = (e, valor) => {
    e.textContent = formatarMoeda(valor);
    e.classList.toggle('neg', valor < 0); e.classList.toggle('pos', valor > 0);
  };

  function irPara(pagina) {
    if (!PAGINAS[pagina]) pagina = 'inicio';
    document.querySelectorAll('.nav-item[data-page]').forEach(b => {
      const ativo = b.dataset.page === pagina;
      b.classList.toggle('active', ativo);
      if (ativo) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    Object.keys(PAGINAS).forEach(p => $(p + 'Page').classList.toggle('hidden', p !== pagina));
    $('pageTitle').textContent = PAGINAS[pagina].titulo;
    $('pageEyebrow').textContent = PAGINAS[pagina].eyebrow;
    if (location.hash !== '#' + pagina) history.replaceState(null, '', '#' + pagina);
  }

  /* ----- Contas, categorias e Início ----- */
  function itemConta(c, comTipo) {
    const li = el('li', 'list-item');
    const info = el('div', 'list-info');
    info.append(el('strong', null, c.nome));
    if (comTipo) info.append(el('small', null, rotuloTipoConta(c.tipo)));
    const valor = el('span', 'money', formatarMoeda(c.saldo_atual));
    if (Number(c.saldo_atual) < 0) valor.classList.add('neg');
    li.append(ponto(c.cor), info, valor);
    return li;
  }
  function listaVazia(ul, texto) { ul.replaceChildren(el('li', 'list-empty', texto)); }

  function desenharBase() {
    const contas = estado.contas.filter(c => !c.arquivada);
    $('saldoTotal').textContent = formatarMoeda(somarSaldos(contas));
    $('saldoResumo').textContent = contas.length === 1 ? 'em 1 conta' : `somando ${contas.length} contas`;
    $('contasQtd').textContent = String(contas.length);
    if (contas.length) {
      $('contasResumo').replaceChildren(...contas.map(c => itemConta(c, false)));
      $('contasLista').replaceChildren(...contas.map(c => itemConta(c, true)));
    } else {
      listaVazia($('contasResumo'), 'Nenhuma conta cadastrada.');
      listaVazia($('contasLista'), 'Nenhuma conta cadastrada.');
    }
    for (const [tipo, ul, qtd] of [['despesa', 'catDespesas', 'despesasQtd'], ['receita', 'catReceitas', 'receitasQtd']]) {
      const cats = estado.categorias.filter(c => c.tipo === tipo);
      $(qtd).textContent = String(cats.length);
      if (cats.length) $(ul).replaceChildren(...cats.map(c => { const li = el('li', 'chip'); li.append(ponto(c.cor), el('span', null, c.nome)); return li; }));
      else listaVazia($(ul), 'Nenhuma categoria.');
    }
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
        db.from('saldos_contas').select('id,nome,tipo,cor,arquivada,saldo_atual').order('nome'),
        db.from('categorias').select('id,nome,tipo,cor,arquivada').eq('arquivada', false).order('nome')
      ]);
      if (contasR.error) throw contasR.error;
      if (catR.error) throw catR.error;
      estado.contas = contasR.data;
      estado.categorias = catR.data;
      desenharBase();
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
    const cats = estado.categorias.filter(c => c.tipo === tipo);
    $('txCategoria').replaceChildren(opcao('', 'Escolha…'), ...cats.map(c => opcao(c.id, c.nome)));
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

  function pedirExclusao() {
    const l = estado.editando;
    if (!l) return;
    estado.excluindo = l;
    $('confirmTexto').textContent = `“${l.descricao}”, ${formatarMoeda(l.valor)}. Esta ação não pode ser desfeita.`;
    $('confirmDialog').showModal();
    $('confirmNao').focus();
  }
  async function confirmarExclusao() {
    const l = estado.excluindo;
    if (!l) return;
    $('confirmSim').disabled = true;
    const { data, error } = await db.from('lancamentos').delete().eq('id', l.id).select('id');
    $('confirmSim').disabled = false;
    $('confirmDialog').close();
    estado.excluindo = null;
    if (error) { aviso('txMensagem', mensagemErroBanco(error)); return; }
    fecharFormulario();
    await carregarDados();
    aviso('globalMessage', data?.length ? 'Lançamento excluído.' : 'O lançamento já tinha sido excluído.', true);
  }

  function mudarMes(delta) {
    Object.assign(estado, somarMes(estado.ano, estado.mes, delta));
    carregarLancamentos().catch(e => { console.error(e); aviso('globalMessage', 'Não foi possível carregar os lançamentos.'); });
  }

  /* ----- Sessão ----- */
  function entrarNoApp(session) {
    $('userEmail').textContent = session.user.email || '';
    mostrar('appView');
    irPara(location.hash.slice(1));
    carregarDados();
  }
  function sairDoApp() {
    if ($('txDialog').open) $('txDialog').close();
    if ($('confirmDialog').open) $('confirmDialog').close();
    Object.assign(estado, { contas: [], categorias: [], lancamentos: [], editando: null, excluindo: null });
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
  $('confirmNao').addEventListener('click', () => { $('confirmDialog').close(); estado.excluindo = null; });
  $('confirmSim').addEventListener('click', confirmarExclusao);
  $('mesAnterior').addEventListener('click', () => mudarMes(-1));
  $('mesSeguinte').addEventListener('click', () => mudarMes(1));
  ['filtroConta', 'filtroCategoria'].forEach(id => $(id).addEventListener('change', desenharLista));
  $('filtroBusca').addEventListener('input', desenharLista);
  $('txDialog').addEventListener('close', () => { estado.editando = null; });

  let sessaoAtual = null;
  db.auth.onAuthStateChange((evento, session) => {
    // Evita recarregar tudo a cada renovação automática do token.
    if (session && (!sessaoAtual || evento === 'SIGNED_IN' && sessaoAtual.user.id !== session.user.id)) entrarNoApp(session);
    if (!session) sairDoApp();
    sessaoAtual = session;
  });
}
