// Cadastro por convite (função "registrar-convite", sem login: quem chama é o convidado).
// Segurança:
// - O código do link tem 43 caracteres aleatórios; o banco só conhece o hash SHA-256 dele.
// - O convite é RESERVADO numa única operação antes de criar a conta: dois cadastros
//   simultâneos com o mesmo link não passam. Se a criação falhar, a reserva é desfeita.
// - A chave de serviço (service_role) só existe aqui no servidor, nunca no site.
// - A resposta não revela se um e-mail já tem conta.
// - Senhas que já apareceram em vazamentos são recusadas (Have I Been Pwned por k-anonimato:
//   só os 5 primeiros caracteres do hash SHA-1 saem do servidor; se o serviço falhar, a senha é aceita).
// Testado em tests/registrar-convite.mjs.

const ORIGENS = ['https://fbi0l.github.io', 'http://localhost:8099'];
const RE_CODIGO = /^[A-Za-z0-9_-]{43}$/;
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

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

async function hexDigest(algoritmo, texto) {
  const buf = await crypto.subtle.digest(algoritmo, new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const hashCodigo = codigo => hexDigest('SHA-256', codigo);

/** Regras da senha. Devolve a mensagem de erro ou null. */
export function validarSenha(senha, email = '') {
  const s = String(senha ?? '');
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (s.length > 72) return 'A senha pode ter no máximo 72 caracteres.';
  if (/^(.)\1+$/.test(s)) return 'Escolha uma senha menos previsível.';
  const usuario = String(email).split('@')[0].toLowerCase();
  if (usuario.length >= 4 && s.toLowerCase().includes(usuario)) return 'A senha não pode conter o seu e-mail.';
  return null;
}

/** true se a senha já apareceu em vazamentos conhecidos (k-anonimato). Em caso de falha do serviço, false. */
export async function senhaVazada(senha, fetchFn = fetch) {
  try {
    const sha1 = (await hexDigest('SHA-1', senha)).toUpperCase();
    const resp = await fetchFn(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' } });
    if (!resp.ok) return false;
    const resto = sha1.slice(5);
    return (await resp.text()).split('\n').some(l => { const [suf, n] = l.trim().split(':'); return suf === resto && Number(n) > 0; });
  } catch (_) { return false; }
}

export async function tratarCadastro(req, { env, criarCliente, fetchFn = fetch }) {
  const origem = req.headers.get('origin') || '';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecalhos(origem) });
  if (req.method !== 'POST') return resposta(origem, 405, { erro: 'Método não permitido.' });
  if (origem && !ORIGENS.includes(origem)) return resposta(origem, 403, { erro: 'Origem não permitida.' });

  const bruto = await req.text();
  if (bruto.length > 4000) return resposta(origem, 413, { erro: 'Pedido grande demais.' });
  let corpo;
  try { corpo = JSON.parse(bruto); } catch (_) { return resposta(origem, 400, { erro: 'Pedido inválido.' }); }
  const codigo = String(corpo?.codigo ?? '');
  if (!RE_CODIGO.test(codigo)) return resposta(origem, 400, { erro: 'Este link de convite está incompleto ou inválido.', codigo_erro: 'invalido' });

  const admin = criarCliente(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const hash = await hashCodigo(codigo);
  const agoraIso = new Date().toISOString();
  const valido = q => q.eq('codigo_hash', hash).is('usado_em', null).is('cancelado_em', null).gt('expira_em', agoraIso);
  const INVALIDO = { erro: 'Este convite não é mais válido: ele já foi usado, foi cancelado ou venceu. Peça um novo link a quem convidou você.', codigo_erro: 'expirado' };

  try {
    if (corpo.acao === 'verificar') {
      const { data, error } = await valido(admin.from('convites').select('rotulo,expira_em')).maybeSingle();
      if (error) throw error;
      if (!data) return resposta(origem, 410, INVALIDO);
      return resposta(origem, 200, { valido: true, rotulo: data.rotulo, expira_em: data.expira_em });
    }

    if (corpo.acao === 'cadastrar') {
      const email = String(corpo.email ?? '').trim().toLowerCase();
      const senha = String(corpo.senha ?? '');
      if (!RE_EMAIL.test(email) || email.length > 254) return resposta(origem, 400, { erro: 'Informe um e-mail válido.' });
      const fraca = validarSenha(senha, email);
      if (fraca) return resposta(origem, 400, { erro: fraca });
      if (await senhaVazada(senha, fetchFn)) return resposta(origem, 400, { erro: 'Essa senha já apareceu em vazamentos de dados na internet. Escolha outra.' });

      // 1) Reserva atômica: só um pedido consegue marcar o convite.
      const { data: reservado, error: errR } = await valido(admin.from('convites').update({ usado_em: agoraIso })).select('id');
      if (errR) throw errR;
      if (!reservado?.length) return resposta(origem, 410, INVALIDO);
      const idConvite = reservado[0].id;

      // 2) Cria a conta já confirmada (o convite comprova o acesso). O gatilho do banco cria contas e categorias padrão.
      const { data: criado, error: errC } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (errC || !criado?.user) {
        await admin.from('convites').update({ usado_em: null }).eq('id', idConvite); // devolve o convite
        const msg = String(errC?.message || '').toLowerCase();
        if (msg.includes('password') && (msg.includes('weak') || msg.includes('short'))) return resposta(origem, 400, { erro: 'Senha fraca demais. Use uma senha mais longa e variada.' });
        // Não revela se o e-mail já existe.
        return resposta(origem, 400, { erro: 'Não foi possível criar o acesso com este e-mail. Confira o e-mail ou fale com quem convidou você.' });
      }
      // 3) Registra quem usou. A conta já existe, então uma falha aqui não desfaz o cadastro: tenta de novo.
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        const { error: errU } = await admin.from('convites').update({ usado_por: criado.user.id }).eq('id', idConvite);
        if (!errU) break;
        if (tentativa === 3) console.error('registrar-convite: convite usado sem registrar quem usou', errU?.code || '');
      }
      return resposta(origem, 201, { ok: true });
    }

    return resposta(origem, 400, { erro: 'Ação desconhecida.' });
  } catch (e) {
    console.error('registrar-convite: erro interno', e?.code || '', e?.name || '');
    return resposta(origem, 500, { erro: 'Não foi possível concluir agora. Tente de novo em instantes.' });
  }
}
