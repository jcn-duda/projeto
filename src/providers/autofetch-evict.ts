// Evicção dirigida dos fallbacks da MESMA obra (Fase 6 do Chupim 2.0) — só a
// LEITURA da evidência de BR ready.
//
// O corpo TS (política + orquestração) MORREU na leva B4: quem decide e apaga é
// o passo nativo `rust/crates/adom-server/src/autofetch/evict_job.rs`, que lê os
// mesmos fatos (registro F2, marker com `obra`, `adsub`/`adhold`/`adprot`, `er:`)
// no `cache.db` compartilhado. O método `adapter.evictFallbacks` ficou sem
// implementação de propósito (`src/debrid/alldebrid.ts:15-20`): sem executor no
// Node, a política daqui só podia sair cedo. As SEIS regras que este módulo
// testava têm porte nativo em `evict_job_tests_rules.rs` (KV → passo) e no
// golden `rust/golden/autofetch-evict-step.jsonl` (régua pura).
//
// O que SOBREVIVE é a evidência do EVENTO `ready`: a chave
// `autofetch:v3:er:<digest>` é escrita pelo passo nativo (e por
// `noteBrReadyNative`, ponte) e LIDA aqui pelo painel, que mostra por obra se o
// BR já ficou pronto. `hasBrReady` é o único consumidor público restante
// (`src/providers/autofetch-obra-summary.ts:75`).

import { readBrReadyNative } from '../utils/autofetch-state-native.js';

/**
 * A obra já provou um BR ready? Lê a evidência `autofetch:v3:er:<digest>`
 * (prefixo RUST_OWNED, TTL da janela do autofetch). É leitura pura: quem grava
 * é o passo nativo da evicção, e só quando o ready é `br` + `dubbed` no
 * registro F2 — "está ready" não basta.
 */
export function hasBrReady(digest: string): boolean {
  return readBrReadyNative(digest) != null;
}
