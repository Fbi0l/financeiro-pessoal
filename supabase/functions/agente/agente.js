// Tratador da função "agente" (relatório do mês e chat).
// Segurança:
// - Exige login: o cliente do banco usa o token do próprio usuário, então as regras de acesso (RLS)
//   garantem que só os dados DELE são lidos. A função não grava nada.
// - Só aceita chamadas do site do app (CORS) e corpos pequenos.
// - As ferramentas da IA são só de leitura e com limites de período e quantidade.
// - Nenhum dado financeiro é registrado em log.
import { montarPacote, linhasLancamentos, agrupar, validarRelatorio, validarMensagens, mesValido, intervaloMes, somarMeses, mesDe } from './analise.js';
import { escolherFornecedor, chamarModelo, promptRelatorio, conversar, ErroIA } from './ia.js';

const ORIGENS = ['https://fbi0l.github.io', 'http://localhost:8099'];
const TAMANHO_MAXIMO = 40000;
const CAMPOS = 'id,tipo,descricao,valor,data,conta_id,conta_destino_id,categoria_id,pago';

function cabecalhos(origem) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
  if (ORIGENS.includes(origem)) {
    h['Access-Control-Allow-Origin'] = origem;
    h['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const resposta = (origem, status, corpo) => new Response(JSON.stringify(corpo), { status, headers: cabecalhos(origem) });

/** Data de hoje em Belém (UTC-3), como AAAA-MM-DD. */
export function hojeBelem(agora = new Date()) {
  return new Date(agora.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
const dataValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
function diasEntre(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

async function lerTudo(db) {
  const [contas, categorias] = await Promise.all([
    db.from('contas').select('id,nome,tipo,arquivada'),
    db.from('categorias').select('id,nome,tipo,arquivada')
  ]);
  if (contas.error) throw contas.error;
  if (categorias.error) throw categorias.error;
  return { contas: contas.data, categorias: categorias.data };
}
async function lerLancamentos(db, inicio, fim, limite = 5000) {
  const { data, error } = await db.from('lancamentos').select(CAMPOS).gte('data', inicio).lte('data', fim)
    .order('data', { ascending: false }).limit(limite);
  if (error) throw error;
  return data;
}

export async function tratar(req, { env, criarCliente, fetchFn = fetch, agora = () => new Date() }) {
  const origem = req.headers.get('origin') || '';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecalhos(origem) });
  if (req.method !== 'POST') return resposta(origem, 405, { erro: 'Método não permitido.' });
  if (origem && !ORIGENS.includes(origem)) return resposta(origem, 403, { erro: 'Origem não permitida.' });

  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return resposta(origem, 401, { erro: 'Entre no app para usar o assistente.' });

  const bruto = await req.text();
  if (bruto.length > TAMANHO_MAXIMO) return resposta(origem, 413, { erro: 'Mensagem grande demais.' });
  let corpo;
  try { corpo = JSON.parse(bruto); } catch (_) { return resposta(origem, 400, { erro: 'Pedido inválido.' }); }

  const db = criarCliente(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: u, error: errU } = await db.auth.getUser(auth.replace(/^Bearer\s+/, ''));
  if (errU || !u?.user) return resposta(origem, 401, { erro: 'Sua sessão expirou. Entre de novo.' });

  const forn = escolherFornecedor(env);
  if (forn.erro) return resposta(origem, 503, { erro: 'O assistente ainda não foi configurado.', detalhe: forn.erro });
  const hoje = hojeBelem(agora());

  try {
    if (corpo.modo === 'relatorio') {
      const mes = corpo.mes || mesDe(hoje);
      if (!mesValido(mes)) return resposta(origem, 400, { erro: 'Mês inválido.' });
      const { contas, categorias } = await lerTudo(db);
      const inicio = intervaloMes(somarMeses(mes, -11)).inicio, fim = intervaloMes(mes).fim;
      const lancamentos = await lerLancamentos(db, inicio, fim);
      const pacote = montarPacote({ lancamentos, contas, categorias, mes, hoje });
      const doMes = lancamentos.filter(l => mesDe(l.data) === mes);
      const mensagens = promptRelatorio(pacote, linhasLancamentos(doMes, categorias, contas, 300));
      let relatorio = null;
      for (let tentativa = 0; tentativa < 2 && !relatorio; tentativa++) {
        const msg = await chamarModelo(forn, {
          messages: tentativa ? [...mensagens, { role: 'user', content: 'Sua resposta anterior não era um JSON válido. Responda só com o JSON no formato pedido.' }] : mensagens,
          max_tokens: 2000
        }, fetchFn);
        relatorio = validarRelatorio(msg.content);
      }
      if (!relatorio) throw new ErroIA('A IA não devolveu uma análise utilizável. Tente de novo.', 'formato', 502);
      return resposta(origem, 200, { mes, totais: pacote.totais, relatorio, fornecedor: forn.nome });
    }

    if (corpo.modo === 'chat') {
      const mensagens = validarMensagens(corpo.mensagens);
      if (!mensagens) return resposta(origem, 400, { erro: 'Escreva uma pergunta.' });
      const { contas, categorias } = await lerTudo(db);
      const contexto = `Contas: ${contas.filter(x => !x.arquivada).map(x => x.nome).join(', ')}\n` +
        `Categorias de saída: ${categorias.filter(x => x.tipo === 'despesa' && !x.arquivada).map(x => x.nome).join(', ')}\n` +
        `Categorias de entrada: ${categorias.filter(x => x.tipo === 'receita' && !x.arquivada).map(x => x.nome).join(', ')}`;

      async function executarFerramenta(nome, a) {
        if (!dataValida(a.inicio) || !dataValida(a.fim) || a.inicio > a.fim) return { erro: 'Período inválido. Use datas AAAA-MM-DD com início antes do fim.' };
        if (diasEntre(a.inicio, a.fim) > 400) return { erro: 'Período longo demais (máximo de 400 dias).' };
        if (nome === 'buscar_lancamentos') {
          let q = db.from('lancamentos').select(CAMPOS).gte('data', a.inicio).lte('data', a.fim).order('data', { ascending: false }).limit(150);
          if (a.texto) q = q.ilike('descricao', '%' + String(a.texto).slice(0, 60).replace(/[%_\\]/g, m => '\\' + m) + '%');
          if (['receita', 'despesa', 'transferencia'].includes(a.tipo)) q = q.eq('tipo', a.tipo);
          if (a.categoria) {
            const cat = categorias.find(x => x.nome.toLowerCase() === String(a.categoria).toLowerCase());
            if (!cat) return { erro: `Categoria "${String(a.categoria).slice(0, 40)}" não existe. Categorias: ${categorias.map(x => x.nome).join(', ')}` };
            q = q.eq('categoria_id', cat.id);
          }
          const { data, error } = await q;
          if (error) throw error;
          const total = data.filter(l => l.pago && l.tipo !== 'transferencia').reduce((s, l) => s + Math.round(Number(l.valor) * 100) * (l.tipo === 'despesa' ? -1 : 1), 0);
          return { quantidade: data.length, limite_atingido: data.length === 150, saldo_do_filtro: total / 100, lancamentos: linhasLancamentos(data, categorias, contas, 150) };
        }
        if (nome === 'resumo_periodo') {
          const lanc = await lerLancamentos(db, a.inicio, a.fim);
          const por = a.agrupar_por === 'estabelecimento' ? 'estabelecimento' : 'categoria';
          const ent = lanc.filter(l => l.pago && l.tipo === 'receita').reduce((s, l) => s + Math.round(Number(l.valor) * 100), 0);
          const sai = lanc.filter(l => l.pago && l.tipo === 'despesa').reduce((s, l) => s + Math.round(Number(l.valor) * 100), 0);
          return { entradas: ent / 100, saidas: sai / 100, resultado: (ent - sai) / 100, grupos: agrupar(lanc, categorias, por) };
        }
        return { erro: 'Ferramenta desconhecida.' };
      }
      async function planoB() {
        const mes = mesDe(hoje);
        const lanc = await lerLancamentos(db, intervaloMes(somarMeses(mes, -11)).inicio, intervaloMes(mes).fim);
        const pacote = montarPacote({ lancamentos: lanc, contas, categorias, mes, hoje });
        const recentes = lanc.filter(l => l.data >= intervaloMes(somarMeses(mes, -1)).inicio);
        return `Resumo do mês atual e histórico (JSON): ${JSON.stringify(pacote)}\nLançamentos deste mês e do anterior:\n${linhasLancamentos(recentes, categorias, contas, 300)}`;
      }
      const r = await conversar({ forn, mensagens, hoje, contexto, executarFerramenta, planoB, fetchFn });
      return resposta(origem, 200, { resposta: r.resposta.slice(0, 4000), modo: r.modo, fornecedor: forn.nome });
    }

    return resposta(origem, 400, { erro: 'Modo desconhecido.' });
  } catch (e) {
    if (e instanceof ErroIA) return resposta(origem, e.status || 502, { erro: e.message, codigo: e.codigo });
    console.error('agente: erro interno', e?.code || '', e?.name || '');
    return resposta(origem, 500, { erro: 'Erro ao consultar seus dados. Tente de novo.' });
  }
}
