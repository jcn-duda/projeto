import { DEFAULT_APP_UPDATES_DIR } from './helpers.js';

// Fábrica (ver server.ts): relê o process.env a cada montagem do config.
// Atualização do app Power Movie servida por esta instância. Sem token a
// rota fica desligada (404): o APK leva as chaves compiladas do app, então o
// download nunca é público.
export const appUpdates = () => ({
  token: (process.env.APP_UPDATE_TOKEN || '').trim(),
  dir: process.env.APP_UPDATE_DIR || DEFAULT_APP_UPDATES_DIR,
});

// FlareSolverr do container (o mesmo que o Jackett usa): resolve os códigos da
// AFTVnews, que passou a exigir desafio do Cloudflare.
export const flaresolverrUrl = () => process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191/v1';
