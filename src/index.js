import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TelegramClient } from 'teleproto';
// teleproto has no `exports` map, so ESM needs the explicit file, not the dir.
import { StringSession } from 'teleproto/sessions/index.js';
import { config, configIssues } from './config.js';
import { Store } from './store.js';
import { startHealthServer, stopHealthServer } from './server.js';
import { registerHandlers } from './handlers/messages.js';
import { log, errText } from './utils/logger.js';

const pkg = createRequire(import.meta.url)('../package.json');

async function resetTmpDir(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
}

async function bootstrap() {
  const issues = configIssues({ requireSession: true });
  if (issues.length) {
    for (const issue of issues) log.error(issue);
    process.exit(1);
  }

  log.info(`⚡️ Elegram v${pkg.version} — Node ${process.version}`);
  const tmpDir = path.join(config.dataDir, 'tmp');
  await resetTmpDir(tmpDir);

  const store = new Store(config.dataDir);
  const ctx = {
    client: null,
    store,
    me: null,
    queue: null,
    archiver: null,
    startedAt: Date.now(),
    connected: false,
  };

  // The health endpoint comes up before Telegram so platform probes (Railway)
  // do not fail while the client is still connecting.
  const server = startHealthServer(config.port, () => ({
    status: ctx.connected ? 'ok' : 'starting',
    uptime: Math.floor(process.uptime()),
    user: ctx.me ? ctx.me.username ?? String(ctx.me.id) : null,
    queue: ctx.queue?.pending ?? 0,
    running: ctx.queue?.running ?? 0,
    archived: store.data.stats.archived,
    // State of the MTProto socket itself, not just of this HTTP process.
    socket: ctx.client?.connected ?? false,
  }));

  const client = new TelegramClient(
    new StringSession(config.session),
    config.apiId,
    config.apiHash,
    {
      deviceModel: config.deviceModel,
      systemVersion: 'linux',
      appVersion: pkg.version,
      connectionRetries: 5,
      retryDelay: 2000,
      autoReconnect: true,
      requestRetries: 3,
    },
  );
  ctx.client = client;

  log.info('در حال اتصال به تلگرام…');
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    throw new Error('SESSION نامعتبر یا منقضی است. دوباره `npm run login` را اجرا کن.');
  }
  ctx.me = await client.getMe();
  ctx.connected = true;
  log.ok(`ورود موفق: @${ctx.me.username ?? ctx.me.id} (${ctx.me.firstName ?? ''})`);

  registerHandlers(ctx);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    ctx.connected = false;
    log.warn(`${signal} دریافت شد؛ خاموشی امن…`);
    try {
      ctx.dispose?.();
      store.flush();
      await stopHealthServer(server);
      await client.disconnect();
    } catch (error) {
      log.error('خطا در خاموشی:', errText(error));
    }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('Promise رد شده بدون هندلر:', errText(reason));
  });
  process.on('uncaughtException', (error) => {
    log.error('خطای غیرمنتظره:', errText(error));
  });
}

bootstrap().catch((error) => {
  log.error('خطای راه‌اندازی:', errText(error));
  process.exit(1);
});
