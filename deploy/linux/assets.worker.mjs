/** Serve only inventoried release assets; native disk listings are never public. */
export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    const inventory = JSON.parse(env.ASSET_INDEX_JSON);
    let file = path.slice(1);
    if (!file) file = 'index.html';
    if (!Object.hasOwn(inventory, file)) {
      if (!request.headers.get('accept')?.includes('text/html')) return new Response(null, { status: 404 });
      file = 'index.html';
    }
    const metadata = inventory[file];
    if (!metadata || !['text/html; charset=utf-8', 'text/css; charset=utf-8', 'text/javascript; charset=utf-8',
      'application/json', 'image/svg+xml', 'image/png', 'image/webp', 'image/jpeg', 'audio/mpeg',
      'font/woff2', 'application/octet-stream'].includes(metadata.contentType))
      return new Response(null, { status: 503 });
    const response = await env.FILES.fetch(new Request('http://release.invalid/' + file, {
      method: request.method,
    }));
    if (!response.ok) return new Response(null, { status: 503 });
    const headers = new Headers(response.headers);
    headers.set('content-type', metadata.contentType);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('etag', '"' + metadata.sha256 + '"');
    headers.set('cache-control', 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  },
};
