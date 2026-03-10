const OPHIM_IMG_ROOT = 'https://img.ophim1.com/uploads/movies/';
const SECRET_KEY = 42;

export const ENABLE_IMAGE_PROXY = false;
export const ENABLE_VIDEO_PROXY = false;

const OPHIM_REFERER = 'https://ophim10.cc/';

/* ---------------- MASK ---------------- */

const mask = (str: string) => {
  const salt = Math.floor(Math.random() * 256);
  const saltHex = salt.toString(16).padStart(2, '0');

  const masked = Array.from(str)
    .map(c =>
      (c.charCodeAt(0) ^ SECRET_KEY ^ salt)
        .toString(16)
        .padStart(2, '0')
    )
    .join('');

  return saltHex + masked;
};

const unmask = (hex: string) => {
  try {
    const salt = parseInt(hex.substring(0, 2), 16);
    const data = hex.substring(2);

    return (
      data
        .match(/.{1,2}/g)
        ?.map(byte =>
          String.fromCharCode(parseInt(byte, 16) ^ SECRET_KEY ^ salt)
        )
        .join('') || ''
    );
  } catch {
    return '';
  }
};

/* ---------------- CLEAN MANIFEST ---------------- */

function cleanManifest(manifest: string) {
  const lines = manifest.split(/\r?\n/);
  const result: string[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line !== "#EXT-X-DISCONTINUITY") {
      result.push(lines[i]);
      i++;
      continue;
    }

    const start = i;
    let j = i + 1;
    let segments = 0;
    let hasKeyNone = false;

    while (j < lines.length) {
      const l = lines[j].trim();

      if (l.startsWith("#EXTINF:")) segments++;

      if (l.includes("#EXT-X-KEY:METHOD=NONE"))
        hasKeyNone = true;

      if (l === "#EXT-X-DISCONTINUITY") break;

      j++;
    }

    if (j >= lines.length) {
      result.push(lines[i]);
      i++;
      continue;
    }

    if (hasKeyNone || (segments >= 5 && segments <= 20)) {
      i = j + 1;
      continue;
    }

    for (let k = start; k <= j; k++) {
      result.push(lines[k]);
    }

    i = j + 1;
  }

  return result.join("\n")
    .replace(/\/convertv7\//g, "/")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/* ---------------- URL RESOLVE ---------------- */

const resolveUrl = (base: string, rel: string) => {
  if (rel.startsWith('http')) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;

  const url = new URL(base);

  if (rel.startsWith('/')) return url.origin + rel;

  const dir = base.substring(0, base.lastIndexOf('/') + 1);

  return dir + rel;
};

/* ---------------- PROXY ---------------- */

export async function handleProxy(c: any) {

  const segments = c.req.path.split('/');
  const type = segments[2];

  /* ---------- IMAGE PROXY ---------- */

  if (type === 'i') {

    if (!ENABLE_IMAGE_PROXY)
      return c.text('Image Proxy is disabled', 403);

    const path = c.req.param('path');

    const targetUrl = path.startsWith('http')
      ? path
      : `${OPHIM_IMG_ROOT}${path}`;

    const cache = (caches as any).default;
    const cacheKey = new Request(c.req.url);

    let cached = await cache.match(cacheKey);

    if (cached) return cached;

    try {

      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
        }
      });

      let newRes = new Response(res.body, res);

      newRes.headers.set('Access-Control-Allow-Origin', '*');
      newRes.headers.set('Cache-Control', 'public, max-age=2592000');

      c.executionCtx.waitUntil(
        cache.put(cacheKey, newRes.clone())
      );

      return newRes;

    } catch {
      return c.text('Image Proxy Error', 500);
    }
  }

  /* ---------- VIDEO PROXY ---------- */

  if (type === 'v') {

    if (!ENABLE_VIDEO_PROXY)
      return c.text('Video Proxy is disabled', 403);

    const hex = c.req.param('hex');

    const baseUrl = unmask(hex);

    if (!baseUrl)
      return c.text('Invalid token', 400);

    const targetUrl = baseUrl;

    try {

      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
          'Referer': OPHIM_REFERER
        }
      });

      if (!res.ok)
        return c.text(`Source Error: ${res.status}`, res.status);

      const contentType = res.headers.get('content-type') || '';

      const isPlaylist =
        targetUrl.includes('.m3u8') ||
        contentType.includes('mpegurl');

      if (isPlaylist) {

        let content = await res.text();

        /* 🔥 CLEAN ADS FIRST */
        content = cleanManifest(content);

        const workerOrigin = new URL(c.req.url).origin;

        const maskUrl = (url: string) => {

          const resolved = resolveUrl(targetUrl, url);

          const filename =
            (resolved.split('/').pop() || 'file.m3u8')
              .split('?')[0];

          return `${workerOrigin}/p/v/${mask(resolved)}/${filename}`;
        };

        /* rewrite normal lines */

        content = content.split('\n').map(line => {

          const trimmed = line.trim();

          if (!trimmed || trimmed.startsWith('#'))
            return line;

          return maskUrl(trimmed);

        }).join('\n');

        /* rewrite URI="..." */

        content = content.replace(
          /(URI=")([^"]+)(")/g,
          (m, p1, p2, p3) => `${p1}${maskUrl(p2)}${p3}`
        );

        return new Response(content, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });
      }

      /* ---------- SEGMENT ---------- */

      let newRes = new Response(res.body, res);

      newRes.headers.set('Access-Control-Allow-Origin', '*');
      newRes.headers.delete('set-cookie');

      return newRes;

    } catch (e: any) {

      return c.text(
        `Proxy Exception: ${e.message}`,
        500
      );
    }
  }

  return c.text('Not Found', 404);
}

export { mask };
