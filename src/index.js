import fs from 'node:fs';
import path from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from './config.js';
import { Store } from './store.js';
import { startHealthServer } from './server.js';
import { registerHandlers } from './handlers/messages.js';
import { log } from './utils/logger.js';

async function bootstrap() {
  console.clear();
  log.info(`⚡️ Elegram v1.0.0 — Node ${process.version}`);

  const dataDir = path.resolve(config.dataDir);
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  for (const f of fs.readdirSync(path.join(dataDir, 'tmp'))) {
    fs.rmSync(path.join(dataDir, 'tmp', f), { recursive: true, force: true });
  }

  if (!config.session) {
    log.error('متغیر SESSION خالی است. ابتدا دستور `npm run login` را اجرا کن.');
    process.exit(1);
  }

  const store = new Store(dataDir);

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    deviceModel: config.deviceModel,
    systemVersion: 'linux',
    appVersion: '1.0.0',
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: true,
    requestRetries: 3,
  });

  const ctx = { client, store, me: null, queue: null, archiver: null, startedAt: Date.now() };

  log.info('در حال اتصال به تلگرام…');
  await client.connect();
  ctx.me = await client.getMe();
  log.ok(`ورود موفق: @${ctx.me.username ?? ctx.me.id} (${ctx.me.firstName ?? ''})`);

  registerHandlers(ctx);

  startHealthServer(config.port, () => ({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    user: ctx.me.username ?? String(ctx.me.id),
    queue: ctx.queue?.pending ?? 0,
    archived: store.data.stats.archived,
  }));

  const shutdown = async (signal) => {
    log.warn(`${signal} دریافت شد؛ خاموشی امن…`);
    try {
      store.flush();
      await client.disconnect();
    } catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((e) => {
  log.error('خطای راه‌اندازی:', e?.errorMessage || e?.message || e);
  process.exit(1);
});
