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
  // Ponte Rust (napi, `rust/crates/adom-napi`): off = só TS; shadow = TS
  // responde e o Rust roda junto só para logar divergência; on = Rust responde
  // (TS de reserva se o Rust lançar). Valor desconhecido vira off.
  rustCore: {
    mode: rustMode(process.env.RUST_CORE),
    // Vazio = dist/rust/adom_napi.node, que o Dockerfile compila.
    path: process.env.RUST_CORE_PATH || '',
    // Teto de divergências logadas por processo (o contador do /metrics segue).
    maxLoggedDiffs: num(process.env.RUST_CORE_MAX_LOGGED_DIFFS, 20),
    // Teto de releases por busca no shadow em lote (`rust-shadow.ts`).
    shadowMaxPerSearch: num(process.env.RUST_CORE_SHADOW_MAX, 300),
  },
  // Índice de releases: fonte de mídia do record (`rust-release-index.ts`).
  // shadow compara fora da resposta; on grava o valor do Rust (TS de reserva).
  rustReleaseIndex: {
    mode: rustMode(process.env.RUST_RELEASE_INDEX, 'off'),
  },
  // Autofetch (Chupim): seleção de candidatos (`rust-autofetch.ts`). shadow
  // compara fora da resposta; on = o Rust escolhe imediatos e fila (TS de
  // reserva). Portões/travas/sonda/escrita da fila seguem no Node.
  rustAutofetch: {
    mode: rustMode(process.env.RUST_AUTOFETCH, 'off'),
  },
  // Debrid: as decisões são do Rust por padrão (on; TS de reserva se o Rust
  // lançar). A rede e a escrita na conta continuam no Node. `off`/`shadow`
  // explícitos voltam ao TS; valor desconhecido = off.
  rustDebrid: {
    // Seletor de arquivo (pickFile).
    file: rustMode(process.env.RUST_DEBRID_FILE, 'on'),
    // Veredito known/unusable a partir da resposta já obtida. Não refaz a API.
    cache: rustMode(process.env.RUST_DEBRID_CACHE, 'on'),
    // Ledger e AIMD do Real-Debrid. O estado continua no Node.
    rd: rustMode(process.env.RUST_DEBRID_RD, 'on'),
    // Decisão de apagar. on só pode recusar um apagamento: a recusa do Node
    // sempre vence, nada sai da conta por causa do Rust.
    clean: rustMode(process.env.RUST_DEBRID_CLEAN, 'on'),
  },
});

/** Ausente usa `fallback`; presente e desconhecido vira off. */
function rustMode(raw: unknown, fallback: 'off' | 'on' = 'off'): 'off' | 'shadow' | 'on' {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  return v === 'shadow' || v === 'on' ? v : 'off';
}
