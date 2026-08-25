import http from 'node:http';
import { log, errText } from './utils/logger.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const send = (res, status, payload, headOnly) => {
  res.writeHead(status, JSON_HEADERS);
  res.end(headOnly ? undefined : JSON.stringify(payload));
};

/**
 * Minimal health endpoint.
 *
 * `/` and `/health` are liveness: they answer 200 as soon as the process is up,
 * even while Telegram is still connecting, so a platform probe (Railway, Fly,
 * K8s) does not kill us mid-boot. `/ready` is readiness and answers 503 until
 * the MTProto socket is authorized — use that one for traffic gating.
 */
export function startHealthServer(port, getState, { onFatal } = {}) {
  const server = http.createServer((req, res) => {
    const headOnly = req.method === 'HEAD';
    if (req.method !== 'GET' && !headOnly) {
      send(res, 405, { ok: false, error: 'method not allowed' }, false);
      return;
    }

    const route = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    let state = {};
    try {
      state = getState?.() ?? {};
    } catch (error) {
      log.warn('[health] تولید وضعیت ناموفق بود:', errText(error));
      state = { status: 'degraded' };
    }

    if (route === '/' || route === '/health' || route === '/healthz') {
      send(res, 200, { ok: true, ...state }, headOnly);
      return;
    }
    if (route === '/ready' || route === '/readyz') {
      const ready = state.status === 'ok';
      send(res, ready ? 200 : 503, { ok: ready, ...state }, headOnly);
      return;
    }
    send(res, 404, { ok: false, error: 'not found' }, headOnly);
  });

  server.on('error', (error) => {
    // A port clash used to be logged and then ignored, leaving a service that
    // looks alive to us and dead to every external probe. Fail loudly instead.
    log.error(`[health] سرور روی پورت ${port} بالا نیامد:`, errText(error));
    if (typeof onFatal === 'function') onFatal(error);
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
    server.closeAllConnections?.();
  });
}
