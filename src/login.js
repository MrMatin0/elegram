#!/usr/bin/env node
import readline from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from './config.js';
import { log } from './utils/logger.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
  deviceModel: config.deviceModel,
});

log.info('اتصال به تلگرام برای ساخت SESSION…');
await client.start({
  phoneNumber: async () => rl.question('📱 شماره تلفن (با کد کشور، مثال: +98912...): '),
  phoneCode: async () => rl.question('🔑 کد دریافتی از تلگرام: '),
  password: async () => rl.question('🔒 رمز تایید دو مرحله‌ای (اگر نداری خالی بگذار): '),
  onError: (e) => log.error(e?.message || e),
});

log.ok('ورود موفق بود!');
console.log('\n🎉 مقدار زیر را در متغیر محیطی SESSION قرار بده:\n');
console.log(client.session.save());
console.log('');

await client.disconnect();
rl.close();
process.exit(0);
