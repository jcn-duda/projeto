// Bloco `autofetch` do `/dashboard-status.json` — ponte primeiro, Node depois.
//
// A admin do gateway (`127.0.0.1:8711`) passou a publicar o estado do worker
// nativo do Chupim (`GET /autofetch`). Este bloco tenta a ponte e, quando ela
// responde, marca `source:'gateway'` e publica a foto nativa em `gateway`; sem
// resposta (rede, prazo ou backoff) ele devolve o snapshot em memória de
// sempre com `source:'node'` — o painel e o `view-chupim.ts` não mudam.
//
// O FORMATO é o do snapshot atual (`paused`, `recheckLots`, `settleLots`,
// `queues`, `budget`, `obras`, `lastSkips`, `config`, `_origem`…). A tradução
// do contrato da admin cabe nesses nomes:
//   - `paused`      ← `status.paused`
//   - `recheckLots` ← `status.lots`   (lotes de recheck persistidos)
//   - `queues.count`← `status.queueDepth` (chaves `autofetch:v3:q:`)
//
// Quem SUBSTITUI os números do Node é só o worker que executa (`enabled:true`).
// Enquanto ele nasce desligado (fase A/B, `phase:"prepared"`), o Chupim de pé é
// o do Node: trocar `recheckLots`/`paused` pela foto nativa apagaria o número
// real do operador (e o botão "Drenar Rechecks" desabilitaria com fila cheia).
import type { AppServices } from './types.js';
import { fetchAutofetchStatus } from '../utils/autofetch-native.js';

export async function autofetchBlock(services: AppServices): Promise<Record<string, unknown>> {
  // Snapshot em memória: o comportamento de hoje, síncrono e sem rede.
  const base: Record<string, unknown> = {
    ...services.autofetch.snapshot(),
    ...services.providers.autofetchStatus(),
  };

  const native = await fetchAutofetchStatus();
  if (!native) return { ...base, source: 'node' };

  const block: Record<string, unknown> = {
    ...base,
    source: 'gateway',
    // Foto crua da admin: `enabled`/`phase` dizem se o worker executa, e
    // `inflight`/`intervalMs` não têm equivalente no snapshot do Node.
    gateway: { ...native },
  };
  if (native.enabled) {
    block.paused = native.paused;
    block.recheckLots = native.lots;
    const queues = (base.queues && typeof base.queues === 'object' ? base.queues : {}) as Record<string, unknown>;
    block.queues = { ...queues, count: native.queueDepth };
  }
  return block;
}
