/* Financeiro pessoal — frontend estático + Supabase.
   A chave abaixo é a chave PUBLICÁVEL do projeto: ela é feita para ficar no navegador.
   Quem protege os dados são as regras de acesso (RLS) do banco: cada linha só é vista pelo seu dono. */
'use strict';

const SUPABASE_URL = 'https://ruphlnabikvnadlmeisg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_sTlK2zW1wno8zVjutjD9JA_r29jZ1JV';

/* ---------- Funções puras (testadas em tests/logica.cjs) ---------- */
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function formatarMoeda(valor) {
  const n = Number(valor);
  return brl.format(Number.isFinite(n) ? n : 0);
}
function somarSaldos(contas) {
  // Soma em centavos para não acumular erro de ponto flutuante.
  const centavos = (contas || [])
    .filter(c => !c.arquivada)
    .reduce((acc, c) => acc + Math.round(Number(c.saldo_atual ?? c.saldo_inicial ?? 0) * 100), 0);
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

if (typeof module !== 'undefined') {
  module.exports = { formatarMoeda, somarSaldos, corSegura, rotuloTipoConta, mensagemErroLogin };
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
  let carregando = false;

  const mostrar = view => ['bootView', 'loginView', 'appView'].forEach(v => $(v).classList.toggle('hidden', v !== view));
  const aviso = (id, texto, ok = false) => { const el = $(id); el.textContent = texto || ''; el.classList.toggle('ok', ok); };
  const el = (tag, cls, texto) => { const e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; };
  const ponto = cor => { const d = el('span', 'dot'); d.style.setProperty('--cor', corSegura(cor)); return d; };

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

  async function carregarDados() {
    if (carregando) return;
    carregando = true;
    $('refreshBtn').disabled = true;
    aviso('globalMessage', 'Atualizando…', true);
    try {
      const [contasR, catR] = await Promise.all([
        db.from('saldos_contas').select('id,nome,tipo,cor,arquivada,saldo_atual').order('nome'),
        db.from('categorias').select('id,nome,tipo,cor,arquivada').eq('arquivada', false).order('nome')
      ]);
      if (contasR.error) throw contasR.error;
      if (catR.error) throw catR.error;

      const contas = contasR.data.filter(c => !c.arquivada);
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
        const cats = catR.data.filter(c => c.tipo === tipo);
        $(qtd).textContent = String(cats.length);
        if (cats.length) $(ul).replaceChildren(...cats.map(c => { const li = el('li', 'chip'); li.append(ponto(c.cor), el('span', null, c.nome)); return li; }));
        else listaVazia($(ul), 'Nenhuma categoria.');
      }
      aviso('globalMessage', '');
    } catch (e) {
      console.error(e);
      aviso('globalMessage', 'Não foi possível carregar os dados. Verifique a conexão e toque em Atualizar.');
    } finally {
      carregando = false;
      $('refreshBtn').disabled = false;
    }
  }

  function entrarNoApp(session) {
    $('userEmail').textContent = session.user.email || '';
    mostrar('appView');
    irPara(location.hash.slice(1));
    carregarDados();
  }
  function sairDoApp() {
    ['saldoTotal'].forEach(id => { $(id).textContent = '—'; });
    ['contasResumo', 'contasLista', 'catDespesas', 'catReceitas'].forEach(id => $(id).replaceChildren());
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
  $('logoutBtn').addEventListener('click', async () => { await db.auth.signOut(); });
  $('refreshBtn').addEventListener('click', carregarDados);
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.addEventListener('click', () => irPara(b.dataset.page)));

  let sessaoAtual = null;
  db.auth.onAuthStateChange((evento, session) => {
    // Evita recarregar tudo a cada renovação automática do token.
    if (session && (!sessaoAtual || evento === 'SIGNED_IN' && sessaoAtual.user.id !== session.user.id)) entrarNoApp(session);
    if (!session) sairDoApp();
    sessaoAtual = session;
  });
}
