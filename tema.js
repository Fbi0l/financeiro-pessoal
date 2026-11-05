/* Tema claro ou escuro.
   Carrega antes do resto da página (sem "defer") para a tela não piscar em branco ao abrir no modo escuro.
   - Sem escolha salva, segue o tema do aparelho (claro ou escuro) e acompanha quando ele muda.
   - Ao tocar no botão do topo, a escolha fica salva neste aparelho. */
'use strict';
(function () {
  const CHAVE = 'tema';
  const COR_BARRA = { claro: '#1e2547', escuro: '#12152b' };

  /** Escolha salva ("claro" ou "escuro") vence; sem escolha válida, segue o aparelho. */
  function resolverTema(escolha, aparelhoEscuro) {
    if (escolha === 'claro' || escolha === 'escuro') return escolha;
    return aparelhoEscuro ? 'escuro' : 'claro';
  }

  if (typeof module !== 'undefined') { module.exports = { resolverTema, COR_BARRA }; return; }

  const midia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let escolhaNaMemoria = null; // vale até fechar, se o navegador não deixar salvar
  const lerEscolha = () => { try { return localStorage.getItem(CHAVE) || escolhaNaMemoria; } catch (_) { return escolhaNaMemoria; } };
  const ouvintes = [];

  function aplicar() {
    const tema = resolverTema(lerEscolha(), Boolean(midia && midia.matches));
    document.documentElement.dataset.tema = tema;
    const barra = document.querySelector('meta[name="theme-color"]');
    if (barra) barra.setAttribute('content', COR_BARRA[tema]);
    ouvintes.forEach(f => { try { f(tema); } catch (_) { /* um ouvinte com erro não impede os outros */ } });
    return tema;
  }

  aplicar();
  if (midia && midia.addEventListener) midia.addEventListener('change', () => { if (!lerEscolha()) aplicar(); });

  window.Tema = Object.freeze({
    atual: () => document.documentElement.dataset.tema,
    definir(tema) {
      escolhaNaMemoria = tema === 'escuro' ? 'escuro' : 'claro';
      try { localStorage.setItem(CHAVE, escolhaNaMemoria); } catch (_) { /* sem armazenamento */ }
      return aplicar();
    },
    alternar() { return this.definir(this.atual() === 'escuro' ? 'claro' : 'escuro'); },
    aoMudar(f) { ouvintes.push(f); }
  });
})();
