#!/usr/bin/env node
import readline from 'node:readline/promises';
import { TelegramClient } from 'teleproto';
// Documented subpath. `teleproto/sessions/index.js` is not in the package's
// "exports" map and Node refuses it with ERR_PACKAGE_PATH_NOT_EXPORTED.
import { StringSession } from 'teleproto/sessions';
import { config, configIssues } from './config.js';
import { log, errText, setLogLevel } from './utils/logger.js';

async function main() {
  const issues = configIssues();
  if (issues.length) {
    for (const issue of issues) log.error(issue);
    return 1;
  }
  setLogLevel(config.logLevel);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    deviceModel: config.deviceModel,
    systemVersion: config.systemVersion,
    connectionRetries: 5,
  });

  try {
    log.info('اتصال به تلگرام برای ساخت SESSION…');
    await client.start({
      phoneNumber: () => rl.question('\u{1F4F1} شماره تلفن (با کد کشور، مثال: +98912...): '),
      phoneCode: () => rl.question('\u{1F511} کد دریافتی از تلگرام: '),
      password: () => rl.question('\u{1F512} رمز تایید دو مرحله‌ای (اگر نداری خالی بگذار): '),
      onError: (error) => {
        log.error(errText(error));
        // Returning false tells teleproto to stop retrying this step.
        return false;
      },
    });

    const me = await client.getMe();
    log.ok(`ورود موفق بود: @${me.username ?? me.id}`);
    console.log('\n\u{1F389} مقدار زیر را در متغیر محیطی SESSION قرار بده:\n');
    console.log(client.session.save());
    console.log('\n\u26A0\uFE0F این رشته حکم رمز عبور اکانتت را دارد. جایی منتشرش نکن.\n');
    return 0;
  } catch (error) {
    log.error('ساخت SESSION ناموفق بود:', errText(error));
    return 1;
  } finally {
    rl.close();
    await Promise.resolve(client.destroy?.()).catch(() => {});
  }
}

process.exit(await main());
