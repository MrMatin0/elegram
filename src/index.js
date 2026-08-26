import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { config, configIssues, configSummary } from './config.js';
import { Store } from './store.js';
import { startHealthServer, stopHealthServer } from './server.js';
import { registerHandlers } from './handlers/messages.js';
import { connect, createClient, SessionError } from './services/client.js';
import { log, errText, setLogLevel } from './utils/logger.js';

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
  setLogLevel(config.logLevel);

  log.info(`\u26A1\uFE0F Elegram v${pkg.version} — Node ${process.version}`);
  log.debug('[config]', JSON.stringify(configSummary()));

  await resetTmpDir(config.tmpDir);
  const store = new Store(config.dataDir);

  const ctx = {
    client: null,
    store,
    me: null,
    queue: null,
    archiver: null,
    mirror: null,
    version: pkg.version,
    startedAt: Date.now(),
    connected: false,
  };

  let shuttingDown = false;
  /**
   * Placeholder until the real handler is wired below.
   *
   * It must still *exit*: the health server can die of a port clash seconds
   * before this gets replaced, and a no-op stub left a process that looks alive
   * to the supervisor and answers nothing — exactly the failure the loud
   * `onFatal` was added to prevent.
   */
  let shutdown = async (signal, code = 1) => {
    log.error(`${signal} پیش از آماده شدن سرویس رخ داد؛ خروج.`);
    process.exit(code);
  };

  // The health endpoint comes up before Telegram so a platform probe (Railway,
  // Fly, K8s) does not fail while the MTProto socket is still connecting.
  const server = startHealthServer(
    config.port,
    () => ({
      status: ctx.connected ? 'ok' : 'starting',
      version: pkg.version,
      uptime: Math.floor(process.uptime()),
      user: ctx.me ? ctx.me.username ?? String(ctx.me.id) : null,
      queue: ctx.queue?.pending ?? 0,
      running: ctx.queue?.running ?? 0,
      archived: store.data.stats.archived,
      bytes: store.data.stats.bytes,
      failed: store.data.stats.failed,
      autoChats: store.autoCount,
      mirrorChats: store.mirrorCount,
      mirrored: ctx.mirror?.stats.captured ?? 0,
      mirrorEdits: ctx.mirror?.stats.edits ?? 0,
      mirrorDeletes: ctx.mirror?.stats.deletions ?? 0,
      // State of the socket itself, not just of this HTTP process.
      socket: Boolean(ctx.client?.connected),
    }),
    { onFatal: () => void shutdown('HEALTH_SERVER_FAILED', 1) },
  );

  const client = createClient(config, { appVersion: pkg.version });
  ctx.client = client;

  log.info('در حال اتصال به تلگرام…');
  ctx.me = await connect(client, { catchUp: config.catchUp });
  ctx.connected = true;
  log.ok(`ورود موفق: @${ctx.me.username ?? ctx.me.id} (${ctx.me.firstName ?? ''})`);

  registerHandlers(ctx, config);

  shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.connected = false;
    log.warn(`${signal} دریافت شد؛ خاموشی امن…`);
    try {
      ctx.dispose?.();
      store.flush();
      await stopHealthServer(server);
      await client.disconnect();
      await Promise.resolve(client.destroy?.()).catch(() => {});
    } catch (error) {
      log.error('خطا در خاموشی:', errText(error));
    } finally {
      await fs.rm(config.tmpDir, { recursive: true, force: true }).catch(() => {});
      process.exit(code);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('Promise رد شده بدون هندلر:', errText(reason));
  });

  // A process that keeps running after an uncaught exception is a process in an
  // unknown state. Log it, flush the store, and let the supervisor restart us.
  process.on('uncaughtException', (error) => {
    log.error('خطای غیرمنتطره:', errText(error));
    void shutdown('UNCAUGHT_EXCEPTION', 1);
  });
}

bootstrap().catch((error) => {
  if (error instanceof SessionError) log.error(errText(error));
  else log.error('خطای راه‌اندازی:', errText(error));
  process.exit(1);
});
