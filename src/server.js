import http from 'node:http';
import { log, errText } from './utils/logger.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function startHealthServer(port, getState) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    if (url !== '/' && url !== '/health') {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    let body;
    try {
      body = JSON.stringify({ ok: true, ...(getState?.() || {}) });
    } catch (error) {
      log.warn('[health] تولید وضعیت ناموفق بود:', errText(error));
      body = JSON.stringify({ ok: true, status: 'degraded' });
    }
    res.writeHead(200, JSON_HEADERS);
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  server.on('error', (error) => {
    log.error(`[health] سرور روی پورت ${port} بالا نیامد:`, errText(error));
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`[health] در حال گوش دادن روی پورت ${port}`);
  });

  return server;
}

export function stopHealthServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
