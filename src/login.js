#!/usr/bin/env node
import readline from 'node:readline/promises';
import { TelegramClient } from 'teleproto';
// teleproto has no `exports` map, so ESM needs the explicit file, not the dir.
import { StringSession } from 'teleproto/sessions/index.js';
import { config, configIssues } from './config.js';
import { log, errText } from './utils/logger.js';

async function main() {
  const issues = configIssues();
  if (issues.length) {
    for (const issue of issues) log.error(issue);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    deviceModel: config.deviceModel,
  });

  try {
    log.info('اتصال به تلگرام برای ساخت SESSION…');
    await client.start({
      phoneNumber: () => rl.question('📱 شماره تلفن (با کد کشور، مثال: +98912...): '),
      phoneCode: () => rl.question('🔑 کد دریافتی از تلگرام: '),
      password: () => rl.question('🔒 رمز تایید دو مرحله‌ای (اگر نداری خالی بگذار): '),
      onError: (error) => log.error(errText(error)),
    });
    log.ok('ورود موفق بود!');
    console.log('\n🎉 مقدار زیر را در متغیر محیطی SESSION قرار بده:\n');
    console.log(client.session.save());
    console.log('');
  } catch (error) {
    log.error('ساخت SESSION ناموفق بود:', errText(error));
    process.exitCode = 1;
  } finally {
    rl.close();
    await client.disconnect().catch(() => {});
    await client.destroy?.().catch(() => {});
  }
}

await main();
process.exit(process.exitCode ?? 0);
