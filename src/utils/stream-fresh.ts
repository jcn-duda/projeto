// Comportamento "fresco" da busca: sem SWR, fast-path, índice e prefetch.
//
// O gate congelado (`STREAM_FROZEN_MODE=record|replay`) e a SEGUNDA request da
// sombra/canário (`X-Adom-Shadow-Frozen: 1`) precisam do MESMO pipeline
// determinístico. Até o F4.2 essa decisão morava em `stream-frozen.ts`; o
// canário direto (F4.3) não pode depender da captura, então o estado vem para
// cá e o `stream-frozen-store` só reexporta `behaviorFrozen` por compatibilidade.
//
// `STREAM_FRESH_REQUESTS=off` restaura o acoplamento antigo: o header só é
// honrado quando `STREAM_FROZEN_MODE` está ativo. O default honra o header
// mesmo sem captura — o gateway o remove da request do cliente, então ele nunca
// é forjável de fora.
import * as runtime from '../runtime.js';

const MODE = String(process.env.STREAM_FROZEN_MODE || '').trim().toLowerCase();
const DIR = String(process.env.STREAM_FROZEN_DIR || '').trim();
const SHADOW_BASE = String(process.env.STREAM_FROZEN_SHADOW_BASE || '').trim();
const HONOR_HEADER = String(process.env.STREAM_FRESH_REQUESTS || '').trim().toLowerCase() !== 'off';

/**
 * `true` quando esta requisição tem que rodar sem cache/atalhos. Em
 * record/replay vale para o processo inteiro (o harness depende disso); no
 * shadow vale só para a request marcada com `X-Adom-Shadow-Frozen: 1`.
 */
export function freshRequest(): boolean {
  // O replay/record do corpus exige o pipeline cru mesmo sem header.
  if (MODE === 'record' || MODE === 'replay') return Boolean(DIR);
  if (runtime.capture()?.shadowFrozen !== true) return false;
  // Novo default (F4.3): o header basta. Sem ele o Node responde a produção
  // normal — o canário direto manda o header e recebe o mesmo pipeline.
  if (HONOR_HEADER) return true;
  return MODE === 'shadow' && Boolean(SHADOW_BASE);
}

/** Só para testes: a env foi lida no load do módulo. */
export const freshMode = Object.freeze({ MODE, HONOR_HEADER, hasDir: Boolean(DIR) });
