// Module Service Worker。登録は { type: 'module' }。
// 役割は2つだけ:
//   1. Web Share Target の POST /share を受け取って IndexedDB に放り込む
//   2. 受け取ったことをページに知らせる
import { addInbox } from './src/db.js';

const CHANNEL = 'triad-inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShare = event.request.method === 'POST' && url.pathname.endsWith('/share');
  if (!isShare) return;

  event.respondWith((async () => {
    let text = '';
    try {
      const fd = await event.request.formData();
      text = [fd.get('title'), fd.get('text'), fd.get('url')]
        .filter((v) => typeof v === 'string' && v.trim())
        .join('\n')
        .trim();
    } catch (err) {
      text = '';
    }

    let id = null;
    if (text) {
      id = await addInbox(text);
      try {
        const bc = new BroadcastChannel(CHANNEL);
        bc.postMessage({ type: 'inbox', id });
        bc.close();
      } catch (err) { /* BroadcastChannel 非対応環境は起動時ドレインに任せる */ }
    }

    const target = new URL('./', self.registration.scope);
    if (id) target.searchParams.set('inbox', id);
    return Response.redirect(target.toString(), 303);
  })());
});
