/* Service worker do app instalável.
   - Guarda SÓ os arquivos do próprio site (telas, estilos, ícones e a biblioteca do Supabase),
     para o app abrir rápido e funcionar como app instalado.
   - NUNCA guarda nada do Supabase (login, lançamentos, IA): esses pedidos passam direto.
   - Rede primeiro: sempre que houver internet, usa a versão mais nova publicada. */
'use strict';
const VERSAO = 'financeiro-v0.6.0';
const ARQUIVOS = [
  './', './index.html', './app.js?v=0.6.0', './importar.js?v=0.6.0', './styles.css?v=0.6.0',
  './manifest.webmanifest', './assets/icone.svg', './assets/icone-192.png', './assets/icone-512.png', './assets/favicon-32.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js'
];
const PERMITIDOS = [self.location.origin, 'https://cdn.jsdelivr.net'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { mode: u.startsWith('http') ? 'cors' : 'same-origin' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(nomes => Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);
  // Só GET de arquivos do próprio site ou do CDN fixo; todo o resto (Supabase, IA) passa direto, sem cópia.
  if (req.method !== 'GET' || !PERMITIDOS.includes(url.origin)) return;
  if (url.origin === self.location.origin && !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  ev.respondWith((async () => {
    const cache = await caches.open(VERSAO);
    try {
      const resp = await fetch(req);
      if (resp.ok && (resp.type === 'basic' || resp.type === 'cors')) cache.put(req, resp.clone());
      return resp;
    } catch (_) {
      const salvo = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      if (salvo) return salvo;
      return new Response('Sem conexão.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
