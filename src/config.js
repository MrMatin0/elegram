import 'dotenv/config';

const need = (key) => {
  const value = process.env[key];
  if (!value) {
    console.error(`✖ متغیر محیطی ${key} تنظیم نشده است.`);
    process.exit(1);
  }
  return value;
};

export const config = {
  apiId: Number(need('API_ID')),
  apiHash: need('API_HASH'),
  session: process.env.SESSION || '',
  storagePeer: process.env.STORAGE_PEER || 'me',
  port: Number(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR || './data',
  deviceModel: process.env.DEVICE_MODEL || 'Elegram Desktop',
};
