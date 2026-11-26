const SHARE_CACHE_NAME = 'expense-tracker-share-target-v1';
const SHARE_CACHE_KEY = '/shared-lottery-image';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('image') || formData.get('file') || formData.get('media');
          if (file && typeof file === 'object' && 'arrayBuffer' in file) {
            const cache = await caches.open(SHARE_CACHE_NAME);
            const headers = new Headers({
              'Content-Type': file.type || 'image/png',
              'X-Shared-Filename': encodeURIComponent(file.name || 'shared-lottery.png'),
            });
            await cache.put(SHARE_CACHE_KEY, new Response(file, { headers }));
          }
        } catch {
          // 忽略解析失敗，仍導向兌獎頁
        }
        const targetUrl = new URL('./', event.request.url).href + '#/lottery?shared=1';
        return Response.redirect(targetUrl, 303);
      })(),
    );
  }
});
