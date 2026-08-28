/*
 * そだちノート / CareOne 共通 Service Worker
 *
 * 目的: 訪問先のマンション廊下・地下・山間部など、電波の届かない場所でも
 *       アプリを起動できるようにする(記録そのものは localStorage なので元から端末内で完結する)。
 *
 * 方針
 *   - アプリ本体(HTML)は stale-while-revalidate:
 *     まずキャッシュを返して即座に開き、裏で最新版を取り直してキャッシュを更新する。
 *     内容が変わっていたら画面に「新しいバージョンがあります」を出す。
 *   - アイコン・マニフェストも同じ扱い。
 *   - **AIリレーサーバへの通信(POST・別オリジン)は一切扱わない**。
 *     キャッシュするのは同一オリジンの GET だけ。
 *
 * 更新のしかた: 配信内容を変えたら CACHE_VERSION を上げる。
 */
const CACHE_VERSION = '2026-08-28b';
const CACHE = 'app-' + CACHE_VERSION;
const BASE = new URL('./', self.location).pathname;   // 例: /dayservice-automate/

const SHELL = [
  BASE, BASE + 'index.html', BASE + 'manifest.webmanifest',
  BASE + 'icons/icon-192.png', BASE + 'icons/icon-512.png', BASE + 'icons/apple-touch-icon.png',
  BASE + 'houmon/', BASE + 'houmon/index.html', BASE + 'houmon/manifest.webmanifest',
  BASE + 'houmon/icons/icon-192.png', BASE + 'houmon/icons/icon-512.png', BASE + 'houmon/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 1つ失敗しても他は入れる(取得できないファイルがあってもインストールを止めない)
    await Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('app-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'version' && e.source) e.source.postMessage({ type: 'sw-version', version: CACHE_VERSION });
});

async function notifyAll(msg) {
  const cs = await self.clients.matchAll({ type: 'window' });
  cs.forEach((c) => c.postMessage(msg));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // AIサーバへのPOSTなどは素通し
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 別オリジンは素通し
  if (!url.pathname.startsWith(BASE)) return;

  const isDoc = req.mode === 'navigate' || req.destination === 'document';

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const net = fetch(req).then(async (res) => {
      if (res && res.ok && res.type === 'basic') {
        if (isDoc && cached) {
          const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
          if (a !== b) notifyAll({ type: 'app-updated' });
        }
        await cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    if (cached) { e.waitUntil(net); return cached; }      // 圏外でもここで開ける

    const res = await net;
    if (res) return res;
    // オフラインでキャッシュも無いとき ― 近いアプリ本体を返す
    const fallback = url.pathname.indexOf(BASE + 'houmon/') === 0
      ? await cache.match(BASE + 'houmon/index.html')
      : await cache.match(BASE + 'index.html');
    return fallback || new Response('オフラインのため表示できません。', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
