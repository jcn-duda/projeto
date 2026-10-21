import { num } from './helpers.js';

// Fábrica (não objeto pronto): módulo ESM é cacheado, e cada re-avaliação do
// compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Identidade do addon, servidor HTTP e logging.
export const server = () => ({
  port: num(process.env.PORT, 7000),
  host: process.env.HOST || '0.0.0.0',
  addonName: process.env.ADDON_NAME || 'Adom Power-Movie',
  addonId: process.env.ADDON_ID || 'community.stremio.adom',
  version: '1.0.0',
  provider: (process.env.PROVIDER || 'demo').toLowerCase(),
  logging: {
    level: process.env.ADDON_LOG_LEVEL || 'info',
  },
  // Ponte Rust (napi, `rust/crates/adom-napi`): o núcleo é obrigatório.
  // `path` é o caminho do `.node`; vazio = dist/rust/adom_napi.node, que o
  // Dockerfile compila. Não há flag de modo.
  rustCore: {
    path: process.env.RUST_CORE_PATH || '',
  },
});
