// Banco de magnets: memória durável POR HASH, escopada por serviço+conta.
//
// Diferente do davail (cache de disponibilidade de TTL curto que responde ao
// checkCached por minutos), isto é o HISTÓRICO de longo prazo: sobrevive dias,
// atravessa buscas e usuários diferentes da mesma conta, e alimenta duas
// decisões na listagem — descartar o que provou estar quebrado e desempatar a
// ordem a favor do que provou tocar na hora.
//
// Regra de ouro: só evidência MEDIDA entra, nunca palpite. Falso negativo é
// pior que falso positivo — descartar um magnet bom esconde stream do usuário.
// Por isso:
// - `alive` nasce de confirmação do debrid (checagem de cache) ou de play que
//   resolveu de verdade no /resolve;
// - `bad` nasce apenas de falha DETERMINÍSTICA do play (torrent sem nenhum
//   arquivo de vídeo). Erro transitório (rede, auth, quota, rate) não grava
//   nada; falha de escolha de arquivo (WorkPickError/EpisodePickError) também
//   não — o pack pode servir outra obra/episódio.
//
// DONO NATIVO (T2-L5b): as linhas `mag:v1:<side>:<adapter>:<conta>:<hash>` são
// do `MagnetStateStore` (Rust). Toda escrita e leitura passa pela ponte
// `debrid-state-native.ts` — este módulo não monta chave nem toca o `cache` do
// Node, que não é dono desse namespace. A ESCRITA saiu para o oráculo de teste
// (`test/helpers/pipeline-oracle/play/magnetdb-writes.ts`): quem grava a
// evidência e o AGREGADO (`mag_meta:v1:counts`, régua `bump_counts`) é o
// gateway. Aqui ficam a limpeza do painel e o status — RECONTO DIRETO do
// físico pela ponte (`summary`/`liveCount`): sem amostra, sem agregado lido
// pelo Node, sem sentinela; a foto do painel é sempre o que está no núcleo
// agora. O relógio da varredura nativa mora em magnetdb-persist.ts.
import config from '../config.js';
import * as metrics from './metrics.js';
import { magnetState, type MagnetSide } from './debrid-state-native.js';
import { QUOTAS } from './cache-quotas.js';
import { sweepNativeNamespaces } from './magnetdb-persist.js';

export { sweepNativeNamespaces };

type TtlRemaining = { alive: number | null; bad: number | null; lie: number | null };

export type MagnetDbAdapterStatus = {
  sizeAlive: number; sizeBad: number; sizeLie: number; ttlRemainingSeconds: TtlRemaining;
};

export type MagnetDbStatus = {
  enabled: boolean;
  aliveTtlSeconds: number;
  badTtlSeconds: number;
  lieTtlSeconds: number;
  sizeAlive: number;
  sizeBad: number;
  sizeLie: number;
  ttlRemainingSeconds: TtlRemaining;
  byAdapter: Record<string, MagnetDbAdapterStatus>;
  l1Entries: number;
  l1Max: number;
  evictedQuota: number;
};

/**
 * Apaga o `bad` de QUALQUER conta do adapter. É o caminho da limpeza do painel,
 * que enumera por adapter e não tem a chave da conta em mãos (o reparo do
 * warmer saiu com o warmer TS). Idempotente: a segunda passada devolve false.
 * `alive`/`lie` do mesmo hash não são tocados.
 *
 * Só a remoção FÍSICA no núcleo: o núcleo apaga o par (adapter, hash) em TODAS
 * as contas e devolve quantas linhas saíram. O agregado NÃO é tocado daqui —
 * quem o mantém é o gateway (régua `bump_counts`), e o status abaixo reconta
 * o físico a cada leitura, então a remoção aparece nela na hora.
 */
function forgetBadOf(adapterId: string, hash: string): boolean {
  return magnetState().forgetBadOf(adapterId, hash) > 0;
}

// Mapeamento do lado físico para o campo do payload do painel.
const SIDE_SIZE: Record<MagnetSide, 'sizeAlive' | 'sizeBad' | 'sizeLie'> = {
  alive: 'sizeAlive', bad: 'sizeBad', lie: 'sizeLie',
};

/** Média de segundos restantes do lado; `null` sem linha alguma (sem 0 falso). */
const mediaTtl = (soma: number, count: number): number | null =>
  count > 0 ? Math.ceil(soma / count) : null;

/**
 * Estado de diagnóstico do painel — RECONTO DIRETO do físico (`summary` +
 * `liveCount` da ponte), custo O(namespace mag) só quando o painel lê, nunca
 * no caminho de busca.
 * - sizeAlive/Bad/Lie + byAdapter: a foto exata do que está no núcleo agora.
 *   A antiga amostra restaurada do agregado morreu: a deriva medida no
 *   cache.db local (agregado dizia 77 alive com 190 chaves vivas, adapter
 *   inteiro sumido do painel) é impossível por construção — não há restauração
 *   nem sentinela de divergência, a leitura É o reconto.
 * - ttlRemainingSeconds: somado do restante REAL de cada linha (`summary`),
 *   não estimativa envelhecida pelo `updatedAt` de um escritor externo.
 * - l1Entries: linhas vivas do namespace mag, contadas pelo NÚCLEO (o Node não
 *   tem o namespace no L1, então `snapshot()` não as enxerga).
 * - l1Max: cota do namespace, de `QUOTAS` (mesmo motivo).
 * - evictedQuota: métrica do cache do Node; a poda é da varredura nativa, que
 *   não alimenta esse contador — fica 0 até o painel ler `sweep()`.
 */
function status(): MagnetDbStatus {
  const now = Date.now();
  const l1Entries = magnetState().liveCount(now);
  let sizeAlive = 0;
  let sizeBad = 0;
  let sizeLie = 0;
  const totalTtlSums = { alive: 0, bad: 0, lie: 0 };
  const byAdapter: Record<string, MagnetDbAdapterStatus> = Object.create(null);

  for (const row of magnetState().summary(now)) {
    const bucket = byAdapter[row.adapter] ?? (byAdapter[row.adapter] = {
      sizeAlive: 0, sizeBad: 0, sizeLie: 0,
      ttlRemainingSeconds: { alive: null, bad: null, lie: null },
    });
    const sizeKey = SIDE_SIZE[row.side];
    bucket[sizeKey] = row.count;
    bucket.ttlRemainingSeconds[row.side] = mediaTtl(row.ttlRemainingSum, row.count);
    if (row.side === 'alive') { sizeAlive += row.count; totalTtlSums.alive += row.ttlRemainingSum; }
    else if (row.side === 'bad') { sizeBad += row.count; totalTtlSums.bad += row.ttlRemainingSum; }
    else { sizeLie += row.count; totalTtlSums.lie += row.ttlRemainingSum; }
  }

  const counters = metrics.snapshot().counters;

  return {
    enabled: config.magnetDb.enabled,
    aliveTtlSeconds: config.magnetDb.aliveTtl,
    badTtlSeconds: config.magnetDb.badTtl,
    lieTtlSeconds: config.magnetDb.lieTtl,
    sizeAlive,
    sizeBad,
    sizeLie,
    ttlRemainingSeconds: {
      alive: mediaTtl(totalTtlSums.alive, sizeAlive),
      bad: mediaTtl(totalTtlSums.bad, sizeBad),
      lie: mediaTtl(totalTtlSums.lie, sizeLie),
    },
    byAdapter,
    l1Entries,
    l1Max: QUOTAS.mag,
    evictedQuota: counters['cache.evicted.quota.mag'] || 0,
  };
}

export {
  forgetBadOf, status,
};
