// Fronteira RUST do debrid (sidecar `adom-debrid`, 127.0.0.1:8710; e o
// `adom-search` in-process no gateway).
//
// Só flags que pertencem ao OUTRO processo mas que o Node precisa espelhar
// para decidir o que preparar/enviar. Quem executa a decisão continua sendo o
// Rust, que relê a mesma env.

import { list } from './helpers.js';

// Ids aceitos no DEBRID_RUST_SERVICES com hífen (como o serviço se apresenta) e
// o id curto do registry Rust, que é quem decide o despacho.
const SERVICE_ALIASES: Record<string, string> = {
  'real-debrid': 'realdebrid',
  'debrid-link': 'debridlink',
  'premiumize-me': 'premiumize',
  'premiumize.me': 'premiumize',
};

export function normalizeRustServices(raw: string | undefined): string[] {
  return list(raw).map((id) => {
    const short = id.toLowerCase();
    return SERVICE_ALIASES[short] ?? short;
  });
}

export const debridRust = () => ({
  // `DEBRID_AL_CLEANUP` (default do corte ON no compose; ver
  // docs/debrid-al-check-rust.md §8). O Node usa a flag só para decidir se
  // PREPARA os fatos do check nativo (hold volátil + inventário). Com OFF, o
  // caminho sem limpeza não ganha leitura extra de `/magnet/status` e o corpo
  // do check fica idêntico ao anterior. A lista de valores é a MESMA que o
  // Rust aceita (`CleanupMode::parse`).
  alCleanup: ['on', '1', 'true', 'yes', 'rust'].includes(
    String(process.env.DEBRID_AL_CLEANUP || '').trim().toLowerCase(),
  ),
});
