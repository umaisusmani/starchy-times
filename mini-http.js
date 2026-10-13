// The small slice of Express this app actually uses: routing with :params, JSON bodies, static files.
// Replaces the express dependency (~15 MB less resident memory, nothing to keep patched).
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.txt': 'text/plain; charset=utf-8',
};
const MAX_BODY = 5 * 1024 * 1024;

function createApp() {
  const routes = [];
  const statics = [];

  const add = method => (pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(pathname, res) {
    for (const { prefix, dir } of statics) {
      if (prefix && pathname !== prefix && !pathname.startsWith(prefix + '/')) continue;
      let rel = pathname.slice(prefix.length);
      if (!rel || rel.endsWith('/')) rel += 'index.html';
      let file;
      try { file = path.normalize(path.join(dir, decodeURIComponent(rel))); } catch { continue; }
      if (file !== dir && !file.startsWith(dir + path.sep)) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': /\.(woff2|ogg)$/.test(file) ? 'public, max-age=86400' : 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => {
      const body = JSON.stringify(obj);
      res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    };
    req.query = Object.fromEntries(url.searchParams);
    req.get = name => req.headers[String(name).toLowerCase()];
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
        req.body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        await r.handler(req, res);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(url.pathname, res)) return;
      res.status(404).json({ error: 'not found' });
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
      else res.end();
    }
  }

  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    static(prefix, dir) { statics.push({ prefix, dir: path.resolve(dir) }); },
    listen(port, host, cb) { return http.createServer(handle).listen(port, host, cb); },
  };
}

module.exports = { createApp };
