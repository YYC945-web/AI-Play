const CACHE_NAME = 'stanly-album-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

// 安装：预缓存静态资源
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(STATIC_ASSETS.map(url =>
        cache.add(url).catch(() => {})
      ));
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求拦截：静态资源缓存优先，其他网络优先
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 跳过 IndexedDB 相关请求和非 GET 请求
  if (e.request.method !== 'GET') return;

  // 静态资源和 CDN 脚本：缓存优先
  const isStatic = STATIC_ASSETS.some(a => url.href.endsWith(a.replace('./', ''))) ||
                   url.pathname.endsWith('.css') ||
                   url.pathname.endsWith('.js') ||
                   url.pathname.endsWith('.png') ||
                   url.pathname.endsWith('.json');

  if (isStatic) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return resp;
        })
      )
    );
  }
});
