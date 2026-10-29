// Teto por OBRA do Chupim (F2) — no Node sobrou SÓ o prefixo do registro.
//
// O corpo TS deste módulo saiu em duas etapas: o laço e a orçamentação foram
// para o worker nativo na leva B4 (2026-10-28) e o resto — identidade, chave,
// digest, reserva, commit, release, `obraRecord`, `forgetObraHash`, `obraStatus`
// — foi FECHADO aqui na leva 6e (2026-10-29). O motivo é medida, não estética:
// os únicos chamadores eram testes (`autofetch-obra-cap`, `-terminal`,
// `-overflow-pending`), e teste medindo espelho do nativo não prova produção.
//
// Onde cada régua mora agora:
// - identidade, chave, digest, teto por pool, `seedsRare`, janela e leitura
//   defensiva: `rust/crates/adom-core/src/autofetch_obra.rs` (`obra_identity`,
//   `obra_key`, `obra_digest`, `pool_cap`, `seeds_rare`, `window_ms`,
//   `read_record`).
// - overflow de upgrade (C11): `rust/crates/adom-core/src/autofetch_obra_overflow.rs`
//   (`quality_rank`, `overflow_upgrade_allowed`).
// - reserva volátil, release e commit: `rust/crates/adom-autofetch/src/v3/obra_reservation.rs`
//   (`ObraReservations::reserve` / `release` / `commit`).
// - registro durável (grava o aceite, esquece o hash terminal):
//   `rust/crates/adom-autofetch/src/v3/obra.rs` e o aceite em
//   `rust/crates/adom-server/src/autofetch/enqueue_obra.rs`.
//
// O que continua sendo do Node: ESTE prefixo. O painel enumera o namespace
// `autofetch:v3:o:` para o resumo por obra (cadeia viva:
// `src/providers/index.ts:12` -> `autofetch-obra-summary.ts` -> aqui). Quem
// grava o registro é o commit nativo, e o prefixo é RUST_OWNED no L1 — este
// arquivo não abre cache, disco nem rede.
import { prefix } from '../utils/cache-keys.js';

/** Prefixo do registro por obra (`autofetch:v3:o:`); dono único = KV nativo. */
export const OBRA_PREFIX = `${prefix('autofetch')}o:`;