/* Importação de extrato: leitura de OFX e CSV, sugestão de categoria e preparação da prévia.
   Tudo roda no navegador: o arquivo nunca é enviado a lugar nenhum além do seu banco no Supabase,
   e só depois que você confirma a prévia. Funções puras, testadas em tests/importar.cjs. */
'use strict';

const Importar = (() => {
  const LIMITE_DESCRICAO = 120;
  const LIMITE_LINHAS = 3000;

  /* ---------- Texto do arquivo ---------- */
  /** Converte os bytes do arquivo em texto, respeitando a codificação (UTF-8 ou Windows-1252, comum em bancos). */
  function decodificar(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const inicio = new TextDecoder('latin1').decode(u8.subarray(0, 400));
    const declara1252 = /CHARSET:\s*(1252|ISO-?8859-?1)|encoding="(windows-1252|iso-8859-1)"/i.test(inicio);
    if (!declara1252) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); } catch (_) { /* não é UTF-8 */ }
    }
    return new TextDecoder('windows-1252').decode(u8).replace(/^﻿/, '');
  }

  const limparEspacos = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  function limparDescricao(s) {
    const t = limparEspacos(decodificarEntidades(s));
    return (t || 'Sem descrição').slice(0, LIMITE_DESCRICAO);
  }
  function decodificarEntidades(s) {
    return String(s ?? '').replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? String.fromCharCode(Number(e.slice(1))));
  }

  /* ---------- Números e datas ---------- */
  /** Lê um valor com sinal em qualquer formato comum: "-1.234,56", "1234.56", "(12,00)", "R$ -10". */
  function lerNumero(texto) {
    let t = String(texto ?? '').replace(/R\$|\s| /g, '');
    if (!t) return null;
    let negativo = false;
    if (/^\(.*\)$/.test(t)) { negativo = true; t = t.slice(1, -1); }
    if (/^[-−]/.test(t)) { negativo = !negativo; t = t.slice(1); } else if (/^\+/.test(t)) t = t.slice(1);
    if (/[-−]$/.test(t)) { negativo = !negativo; t = t.slice(0, -1); } // "12,00-" (alguns bancos)
    if (!/^[\d.,]+$/.test(t)) return null;
    const ultPonto = t.lastIndexOf('.'), ultVirg = t.lastIndexOf(',');
    if (ultPonto >= 0 && ultVirg >= 0) {
      const dec = ultPonto > ultVirg ? '.' : ',';
      t = t.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (ultVirg >= 0) {
      if ((t.match(/,/g) || []).length > 1) t = t.replace(/,/g, ''); else t = t.replace(',', '.');
    } else if (ultPonto >= 0 && /^\d{1,3}(\.\d{3})+$/.test(t) && (t.match(/\./g) || []).length > 1) {
      t = t.replace(/\./g, '');
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.round((negativo ? -n : n) * 100) / 100;
  }
  const doisDigitos = n => String(n).padStart(2, '0');
  function montarData(a, m, d) {
    a = Number(a); m = Number(m); d = Number(d);
    if (a < 100) a += 2000;
    const dt = new Date(Date.UTC(a, m - 1, d));
    if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || a < 2000 || a > 2100) return null;
    return `${a}-${doisDigitos(m)}-${doisDigitos(d)}`;
  }
  /** Datas de extrato: 31/12/2026, 31-12-26, 2026-12-31 ou 20261231 (OFX). */
  function lerData(texto) {
    const t = String(texto ?? '').trim();
    let m;
    if ((m = t.match(/^(\d{4})(\d{2})(\d{2})/))) return montarData(m[1], m[2], m[3]);
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return montarData(m[1], m[2], m[3]);
    if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/))) return montarData(m[3], m[2], m[1]);
    return null;
  }

  /* ---------- OFX ---------- */
  function campoOFX(bloco, tag) {
    // Serve para OFX 1.x (SGML, sem fechar a tag) e 2.x (XML).
    const m = bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
    return m ? m[1].trim() : '';
  }
  function lerOFX(texto) {
    const cartao = /<CCSTMTRS>/i.test(texto);
    const banco = campoOFX(texto, 'BANKID') || campoOFX(texto, 'ORG');
    const conta = campoOFX(texto, 'ACCTID');
    const blocos = texto.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
    const movimentos = [];
    for (const b of blocos) {
      const valor = lerNumero(campoOFX(b, 'TRNAMT'));
      const data = lerData(campoOFX(b, 'DTPOSTED'));
      const nome = limparEspacos(decodificarEntidades(campoOFX(b, 'NAME')));
      const memo = limparEspacos(decodificarEntidades(campoOFX(b, 'MEMO')));
      let descricao = nome && memo && !memo.toLowerCase().includes(nome.toLowerCase()) && !nome.toLowerCase().includes(memo.toLowerCase())
        ? `${nome} - ${memo}` : (memo.length > nome.length ? memo : nome);
      movimentos.push({ data, valor, descricao: limparDescricao(descricao), fitid: campoOFX(b, 'FITID') });
    }
    const saldo = lerNumero(campoOFX(texto.split(/<LEDGERBAL>/i)[1] || '', 'BALAMT'));
    return { formato: 'OFX', tipoExtrato: cartao ? 'cartao' : 'conta', banco, conta, saldoFinal: saldo, movimentos };
  }

  /* ---------- CSV ---------- */
  function separarCSV(texto) {
    const linhas = texto.split(/\r\n|\n|\r/).filter(l => l.trim());
    const amostra = linhas.slice(0, 20).join('\n');
    const contar = d => (amostra.match(new RegExp(d === '\t' ? '\\t' : `\\${d}`, 'g')) || []).length;
    const sep = [';', ',', '\t'].sort((a, b) => contar(b) - contar(a))[0];
    const cel = linha => {
      const out = []; let atual = '', aspas = false;
      for (let i = 0; i < linha.length; i++) {
        const c = linha[i];
        if (aspas) {
          if (c === '"' && linha[i + 1] === '"') { atual += '"'; i++; } else if (c === '"') aspas = false; else atual += c;
        } else if (c === '"') aspas = true; else if (c === sep) { out.push(atual.trim()); atual = ''; } else atual += c;
      }
      out.push(atual.trim());
      return out;
    };
    return linhas.map(cel);
  }
  const semAcento = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const NOMES = {
    data: /^(data|date|dt|data (do )?lancamento|data mov(imento)?)$/,
    valor: /^(valor|amount|value|quantia|valor \(r\$\)|valor r\$)$/,
    descricao: /^(descricao|historico|lancamento|title|titulo|memo|detalhe|detalhes|descricao do lancamento|estabelecimento|origem ?\/ ?destino)$/,
    hora: /^(hora|horario)$/,
    credito: /^(credito|entrada|entradas|credito \(r\$\))$/,
    debito: /^(debito|saida|saidas|debito \(r\$\))$/,
    id: /^(identificador|id|fitid|codigo|documento|n. documento|numero do documento)$/,
    complemento: /^(detalhes|complemento)$/,
    tipo: /^(tipo lancamento|tipo de lancamento|tipo)$/
  };
  // Identificador de verdade (único no banco) x número de documento (o BB e outros repetem entre lançamentos).
  const ID_UNICO = /^(identificador|id|fitid)$/;
  function lerCSV(texto) {
    const linhas = separarCSV(texto);
    let cab = -1, col = {};
    for (let i = 0; i < Math.min(linhas.length, 15) && cab < 0; i++) {
      const c = {};
      linhas[i].forEach((nome, j) => {
        const n = semAcento(nome);
        for (const [campo, re] of Object.entries(NOMES)) if (re.test(n) && c[campo] === undefined) c[campo] = j;
      });
      if (c.data !== undefined && c.descricao !== undefined && (c.valor !== undefined || c.credito !== undefined || c.debito !== undefined)) { cab = i; col = c; }
    }
    if (cab < 0) {
      const erro = new Error('Não reconheci as colunas deste CSV. Ele precisa ter colunas de data, descrição e valor.');
      erro.codigo = 'csv_colunas'; throw erro;
    }
    const titulos = linhas[cab].map(semAcento).join('|');
    const nomesCab = linhas[cab].map(semAcento);
    const idUnico = col.id !== undefined && ID_UNICO.test(nomesCab[col.id]);
    const usaComplemento = col.complemento !== undefined && col.complemento !== col.descricao;
    // Banco do Brasil: "Data, Lançamento, Detalhes, N° documento, Valor, Tipo Lançamento" (atual)
    // ou "Data, Dependencia Origem, Histórico, Data do Balancete, Número do documento, Valor" (antigo).
    const bancoDoBrasil = (/(^|\|)lancamento\|detalhes(\||$)/.test(titulos) && /tipo lancamento/.test(titulos)) || /dependencia origem/.test(titulos);
    // Fatura do cartão Nubank: "date,title,amount" (compras positivas).
    const cartaoNubank = titulos === 'date|title|amount';
    // PicPay: "data,hora,tipo,origem / destino,valor,forma de pagamento" (valor com sinal, ex.: "−R$ 25,00").
    const picpay = /origem ?\/ ?destino/.test(titulos) && /forma de pagamento/.test(titulos);
    const movimentos = [];
    for (const l of linhas.slice(cab + 1)) {
      const data = lerData(l[col.data]);
      if (!data) continue; // linhas de total, saldo ou rodapé
      let valor;
      if (col.valor !== undefined) valor = lerNumero(l[col.valor]);
      else {
        const cr = lerNumero(l[col.credito]) || 0, db = lerNumero(l[col.debito]) || 0;
        valor = Math.round((Math.abs(cr) - Math.abs(db)) * 100) / 100;
      }
      if (cartaoNubank && valor != null) valor = -valor;
      if (col.tipo !== undefined && valor != null) {
        const tipo = semAcento(l[col.tipo]);
        if (/^(saida|debito|d)$/.test(tipo)) valor = -Math.abs(valor);
        else if (/^(entrada|credito|c)$/.test(tipo)) valor = Math.abs(valor);
      }
      let descricao = limparEspacos(l[col.descricao]);
      if (picpay && col.tipo !== undefined) {
        // "Compra realizada" + "PicPay Shop" -> "Compra realizada - PicPay Shop"
        const op = limparEspacos(l[col.tipo]);
        if (op && !semAcento(descricao).includes(semAcento(op))) descricao = descricao ? `${op} - ${descricao}` : op;
      }
      if (usaComplemento) {
        // "03/10 14:22 Fulano de Tal" -> "Fulano de Tal" (a data já está na coluna própria).
        const comp = limparEspacos(l[col.complemento]).replace(/^\d{2}\/\d{2}(\/\d{2,4})?(\s+\d{2}:\d{2}(:\d{2})?)?\s*/, '');
        if (comp && !semAcento(descricao).includes(semAcento(comp))) descricao = descricao ? `${descricao} - ${comp}` : comp;
      }
      // Número de documento não é único: só identifica junto com a data e o valor.
      const doc = col.id !== undefined ? String(l[col.id] || '').trim() : '';
      let fitid = !doc ? '' : idUnico ? doc : (/^0*$/.test(doc) || valor == null ? '' : `doc:${data}:${Math.round(valor * 100)}:${doc}`);
      // PicPay não tem identificador: data, hora e valor identificam (repetidos no mesmo minuto ganham #2 em idsExternos).
      const hora = col.hora !== undefined ? String(l[col.hora] || '').trim() : '';
      if (picpay && !fitid && valor != null && /^\d{1,2}:\d{2}(:\d{2})?$/.test(hora)) fitid = `pp:${data}T${hora}:${Math.round(valor * 100)}`;
      movimentos.push({ data, valor, descricao: limparDescricao(descricao), fitid });
    }
    const nubankConta = /^data\|valor\|identificador\|descricao$/.test(titulos);
    return { formato: nubankConta ? 'CSV do Nubank' : cartaoNubank ? 'CSV do cartão Nubank' : bancoDoBrasil ? 'CSV do Banco do Brasil' : picpay ? 'CSV do PicPay' : 'CSV', tipoExtrato: cartaoNubank ? 'cartao' : 'conta', banco: '', conta: '', saldoFinal: null, movimentos };
  }

  /** Lê um extrato (OFX ou CSV) e devolve os movimentos já limpos, sem linhas de saldo e sem valor zero. */
  function lerExtrato(texto, nomeArquivo = '') {
    const ehOFX = /<OFX>|OFXHEADER:|<\?OFX/i.test(texto.slice(0, 2000)) || /\.ofx$/i.test(nomeArquivo);
    const r = ehOFX ? lerOFX(texto) : lerCSV(texto);
    const descartados = { saldo: 0, invalidos: 0 };
    r.movimentos = r.movimentos.filter(m => {
      if (/^(saldo|s a l d o)\b|saldo (anterior|do dia|final|disponivel)/i.test(semAcento(m.descricao))) { descartados.saldo++; return false; }
      if (!m.data || m.valor == null || m.valor === 0) { descartados.invalidos++; return false; }
      return true;
    });
    if (r.movimentos.length > LIMITE_LINHAS) {
      const erro = new Error(`O arquivo tem ${r.movimentos.length} movimentos. Importe no máximo ${LIMITE_LINHAS} de cada vez (um período menor).`);
      erro.codigo = 'muitas_linhas'; throw erro;
    }
    r.descartados = descartados;
    return r;
  }

  /* ---------- Identificador para não importar duas vezes ---------- */
  function hash32(s, semente) {
    let h = semente >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  /** Identificador estável de cada movimento: o do banco (FITID) quando existe; senão, data+valor+descrição.
      Movimentos idênticos no mesmo arquivo (dois cafés iguais no mesmo dia) recebem #2, #3… */
  function idsExternos(movimentos) {
    const vistos = new Map();
    return movimentos.map(m => {
      const base = m.fitid
        ? 'b:' + String(m.fitid).trim().slice(0, 150)
        : 'h:' + m.data + ':' + Math.round(m.valor * 100) + ':' + hash32(semAcento(m.descricao), 2166136261) + hash32(semAcento(m.descricao), 5381);
      const n = (vistos.get(base) || 0) + 1;
      vistos.set(base, n);
      return n === 1 ? base : `${base}#${n}`;
    });
  }

  /* ---------- Sugestão de categoria ---------- */
  /** Descrição sem números, datas e códigos, para reconhecer o mesmo estabelecimento em meses diferentes. */
  function chaveDescricao(s) {
    return semAcento(s).replace(/\d+/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\b(pix|ted|doc|compra|pagamento|pagto|pag|debito|credito|cartao|transf(erencia)?|enviad[oa]|recebid[oa]|no|na|de|do|da|em|com)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const REGRAS = [
    ['despesa', 'Supermercado', /supermerc|mercado|atacad|assai|carrefour|mateus|formosa|libero|nazare|big bom|hiper|extra hiper|pao de acucar|hortifruti|feira/],
    ['despesa', 'Alimentação', /ifood|i food|restaurante|lanchonete|padaria|pizza|burger|mcdonald|mc donald|bk |habib|rappi|acai|cafe|cafeteria|churrasc|bar |sorvet|lanche/],
    ['despesa', 'Transporte', /uber|99 ?app|99 ?pop|99 ?tecnologia|posto|combust|gasolina|shell|ipiranga|petrobras|estaciona|onibus|passagem|metro|pedagio|indriver/],
    ['despesa', 'Celular e internet', /\bvivo\b|\bclaro\b|\btim\b|\boi\b|internet|telefon|recarga/],
    ['despesa', 'Assinaturas', /netflix|spotify|prime video|amazon prime|disney|youtube|google one|icloud|apple\.com|apple com|hbo|\bmax\b|globoplay|deezer|openai|chatgpt|anthropic|claude|assinatura/],
    ['despesa', 'Moradia', /aluguel|condominio|equatorial|celpa|cosanpa|energia|\bagua\b|\bluz\b|\biptu\b|gas /],
    ['despesa', 'Saúde', /farmac|drogaria|drogasil|droga raia|pague menos|extrafarma|hospital|clinica|laborat|unimed|hapvida|odonto|medic/],
    ['despesa', 'Educação', /escola|faculdade|universidade|curso|udemy|alura|livraria|mensalidade/],
    ['despesa', 'Lazer', /cinema|cinepolis|ingresso|steam|playstation|xbox|nintendo|show|teatro|viagem|hotel|airbnb/],
    ['despesa', 'Compras', /shopee|mercado ?livre|mercadolivre|amazon|magalu|magazine|americanas|shein|aliexpress|renner|riachuelo|c ?& ?a\b/],
    ['receita', 'Salário', /salario|folha|proventos|vencimentos|remuneracao/],
    ['receita', 'Pix recebido', /pix.*receb|receb.*pix|transferencia recebida|ted recebida|doc recebido/]
  ];
  /** Sugere uma categoria: primeiro pelo seu histórico (mesmo estabelecimento), depois por palavras-chave,
      e por fim "Outras despesas"/"Outras receitas". Devolve { id, motivo }. */
  function sugerirCategoria(descricao, tipo, categorias, historico) {
    const cats = (categorias || []).filter(c => c.tipo === tipo && !c.arquivada);
    const valida = id => cats.some(c => c.id === id);
    const chave = chaveDescricao(descricao);
    if (chave && historico) {
      const id = historico.get(tipo + '|' + chave);
      if (id && valida(id)) return { id, motivo: 'historico' };
    }
    const texto = ' ' + semAcento(descricao) + ' ';
    for (const [t, nome, re] of REGRAS) {
      if (t !== tipo || !re.test(texto)) continue;
      const c = cats.find(x => semAcento(x.nome) === semAcento(nome));
      if (c) return { id: c.id, motivo: 'palavra' };
    }
    const outras = cats.find(c => semAcento(c.nome) === (tipo === 'receita' ? 'outras receitas' : 'outras despesas'));
    return { id: outras ? outras.id : '', motivo: 'padrao' };
  }
  /** Monta o "aprendizado" a partir dos lançamentos já categorizados (o mais recente vence). */
  function montarHistorico(lancamentos) {
    const mapa = new Map();
    for (const l of lancamentos || []) {
      if (!l.categoria_id || l.tipo === 'transferencia') continue;
      const chave = chaveDescricao(l.descricao);
      const k = l.tipo + '|' + chave;
      if (chave && !mapa.has(k)) mapa.set(k, l.categoria_id);
    }
    return mapa;
  }

  /* ---------- Prévia ---------- */
  /** Junta tudo: tipo pelo sinal, identificador, categoria sugerida e situação de cada linha.
      situacao: 'nova' | 'importada' (mesmo identificador já no banco) | 'parecida' (mesma data e valor de um lançamento manual). */
  function prepararPrevia(extrato, { categorias, historico, idsExistentes, existentes } = {}) {
    const ids = idsExternos(extrato.movimentos);
    const jaTem = idsExistentes || new Set();
    const manuais = new Map();
    for (const l of existentes || []) {
      if (l.id_externo || l.tipo === 'transferencia') continue;
      const k = l.data + '|' + l.tipo + '|' + Math.round(Number(l.valor) * 100);
      manuais.set(k, (manuais.get(k) || 0) + 1);
    }
    return extrato.movimentos.map((m, i) => {
      const tipo = m.valor < 0 ? 'despesa' : 'receita';
      const valor = Math.abs(m.valor);
      const sug = sugerirCategoria(m.descricao, tipo, categorias, historico);
      let situacao = 'nova';
      if (jaTem.has(ids[i])) situacao = 'importada';
      else {
        const k = m.data + '|' + tipo + '|' + Math.round(valor * 100);
        if (manuais.get(k)) { situacao = 'parecida'; manuais.set(k, manuais.get(k) - 1); }
      }
      return { ...m, tipo, valor, id_externo: ids[i], categoria_id: sug.id, motivo: sug.motivo, situacao, incluir: situacao === 'nova' };
    });
  }
  function resumoPrevia(linhas) {
    const r = { total: linhas.length, novas: 0, importadas: 0, parecidas: 0, incluidas: 0, entradas: 0, saidas: 0, inicio: null, fim: null };
    let ent = 0, sai = 0;
    for (const l of linhas) {
      r[{ nova: 'novas', importada: 'importadas', parecida: 'parecidas' }[l.situacao]]++;
      if (!r.inicio || l.data < r.inicio) r.inicio = l.data;
      if (!r.fim || l.data > r.fim) r.fim = l.data;
      if (!l.incluir) continue;
      r.incluidas++;
      if (l.tipo === 'receita') ent += Math.round(l.valor * 100); else sai += Math.round(l.valor * 100);
    }
    r.entradas = ent / 100; r.saidas = sai / 100;
    return r;
  }
  /** Registros prontos para gravar (só as linhas marcadas), ligados ao registro da importação. */
  function registrosParaGravar(linhas, contaId, importacaoId = null) {
    return linhas.filter(l => l.incluir).map(l => ({
      tipo: l.tipo, descricao: l.descricao, valor: l.valor, data: l.data, conta_id: contaId,
      conta_destino_id: null, categoria_id: l.categoria_id || null, pago: true, observacoes: null,
      origem: 'importacao', id_externo: l.id_externo, importacao_id: importacaoId
    }));
  }
  /** Registro da importação (para poder apagá-la depois): nome do arquivo, formato e período das linhas marcadas. */
  function dadosDaImportacao(linhas, extrato, nomeArquivo, contaId) {
    const datas = linhas.filter(l => l.incluir).map(l => l.data).sort();
    if (!datas.length) return null;
    const arquivo = limparEspacos(nomeArquivo).slice(0, 120) || 'extrato';
    return { conta_id: contaId, arquivo, formato: String(extrato?.formato || 'Extrato').slice(0, 40), periodo_inicio: datas[0], periodo_fim: datas[datas.length - 1] };
  }

  return { decodificar, lerNumero, lerData, lerOFX, lerCSV, lerExtrato, idsExternos, chaveDescricao, sugerirCategoria, montarHistorico, prepararPrevia, resumoPrevia, registrosParaGravar, dadosDaImportacao };
})();

if (typeof module !== 'undefined') module.exports = Importar;
