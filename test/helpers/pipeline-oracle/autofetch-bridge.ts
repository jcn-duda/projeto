// ORÁCULO — ADAPTADOR LOCAL DO CHUPIM (NÃO É CÓDIGO DE PRODUÇÃO).
//
// A leva B4 (2026-10-28) tirou o corpo TS do Chupim de `src/`:
// `autoFetchCandidates` (`autofetch-candidates.ts`), `autoFetchBrDubbed` e
// `releaseAllHolds` (`autofetch-runner.ts`) não existem mais. O `applyDebrid`
// congelado continua precisando dos TRÊS efeitos que os testes medem, e este
// módulo os produz só com peças que SOBREVIVEM ao corte:
//
//   seleção  → `decideAutofetch` (`src/utils/rust-autofetch.ts`), o MESMO lote
//              nativo que o runner consumia: nenhuma cascata/pool é reescrita
//              aqui — o oráculo continua medindo a decisão do NÚCLEO;
//   posse    → `src/debrid/protected.ts` (`hold`/`release`/`protectBr`): o hold
//              do candidato é tomado ANTES da checagem (invariante 6 —
//              autofetch x dropUncached);
//   disparo  → `enqueue` (play/actions.ts) + marker/trava/vaga de
//              `src/providers/autofetch.ts` (a única glue que não virou nativa).
//
// O QUE O ORÁCULO DEIXOU DE MEDIR depois do corte (e por quê):
//
// - **teto por OBRA** (`reserveObra`/`commitObra`/`releaseObra`): a reserva F2
//   saiu com o lote; o portão é do worker nativo. Sem a reserva, o oráculo não
//   mede `obra-cap` (nem o `run` de evicção que ela alimentava).
// - **fila persistente** (`writeQueue` da seleção, `purgeSeedsQueue`,
//   `toQueueCandidate`): o escritor único da fila `autofetch:v3:q:` é o nativo.
//   O oráculo devolve a lista escolhida e a contagem de disparos, não a fila.
// - **recheck/settle/drain** (`scheduleRecheck`, `drainNext`, `autofetch-recheck`,
//   `autofetch-settle`, `autofetch-drain`): o oráculo dispara o enqueue e NÃO
//   acompanha o download. `autofetchCount` conta o que sairia nesta busca. O
//   ciclo em si é do worker nativo (`recheck_poll.rs`).
// - **sonda BR** (`requestBrProbe`/`probeBlocksSeeds`, `br-probe.ts`): o fato
//   `seedsBlocked` continua sendo ENTRADA do lote nativo, mas o bloqueio
//   transitório `br-probe-pending` não tem mais produtor aqui (a sonda é do
//   worker). `dubbed-only` e `seeds-playable` seguem como fato — ver
//   `seedsBlockedFact`.
// - **skips/trace do Chupim** (`noteSkip`, `writeChupimTrace`): diagnóstico do
//   runner apagado na B4. Não há escritor no Node; nada disso entra na resposta
//   do `applyDebrid`.
// - **registro no índice** (`recordAutofetchRelease`): saiu do Node; quem grava
//   é o ACEITE nativo (`rust/crates/adom-server/src/autofetch/index_record.rs`,
//   `source:'autofetch'`). O oráculo não registra nada.
// - **marker com `obra`** (`evictMarkerMeta` saiu na B4): o enqueue nativo grava
//   pelo `obra::marker_meta`; o oráculo grava a forma `1`/`{id}` — a que os
//   testes medem (`kvPeek(markerKey(...)) === 1`).
//
// Regra do diretório: NÃO "acompanhe" produção aqui. Comportamento novo do
// Chupim se valida no núcleo Rust; este adaptador existe para o `applyDebrid`
// congelado continuar chamando o mesmo contrato observável.
import config from '../../../src/config.js';
import type { DebridAdapter, Stream } from '../../../types/domain.js';
import { opts } from '../../../src/runtime.js';
import { accountScope } from '../../../src/utils/request-key.js';
import autofetchLive from '../../../src/utils/autofetch-live.js';
import { isSeasonPackFillEligible, streamQuality } from '../../../src/utils/format.js';
import {
  canAutoFetchBr,
  cachedBrDubbedTargetQualities,
  hasCachedAnyDubbed,
  hasCachedBrDubbed,
  isAutofetchTargetQuality,
} from './autofetch-ranking.js';
import { decideAutofetch, type AutofetchPick } from '../../../src/utils/rust-autofetch.js';
import * as autofetch from '../../../src/providers/autofetch.js';
import * as accountGate from './autofetch-account-gate.js';
import * as held from '../../../src/debrid/protected.js';
import { reuploadBlocked } from '../../../src/debrid/alldebrid-reupload.js';
import { unblockIfInventoryReady } from './debrid-bodies/alldebrid-autofetch.js';
import { enqueue } from './play/actions.js';
import { rawAdapter } from './raw-adapter.js';
import * as log from '../../../src/utils/logger.js';
import * as metrics from '../../../src/utils/metrics.js';
import type { StreamTraceState } from '../../../src/utils/stream-trace.js';
import { assertSafeTestDb } from '../db-guard.js';

// O adaptador grava marker/`adrm` no KV nativo (`setMarker`) e lê a blacklist:
// sem setup-env o destino é o `data/cache.db` do repositório.
assertSafeTestDb('pipeline-oracle/autofetch-bridge');

/** Stream com hash provado — o núcleo só escolhe hash da lista viva. */
type OracleStream = Stream & { infoHash: string };

/** O candidato que a seleção devolvia (mesma forma do `AutoFetchCandidate`). */
export type OracleCandidate = {
  stream: OracleStream;
  account: string;
  pool: string;
  slotLimit?: number;
  rare?: boolean;
};

type CandidatesRequest = {
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
  trace?: StreamTraceState | null;
};

type PostCheckRequest = {
  cached: Set<string>;
  known: boolean;
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
  trace?: StreamTraceState | null;
};

function hasHash(stream: Stream): stream is OracleStream {
  return typeof stream.infoHash === 'string' && stream.infoHash.length > 0;
}

/**
 * Fato `seeds_blocked` do contrato nativo: o lote NÃO recebe a lista tocável
 * nem a sonda, então quem chama pré-computa o bloqueio de SELEÇÃO do pool
 * seeds. A decisão vivia em `seedsSelectionBlock` (`autofetch-policy.ts`,
 * removida na B4) e só as três primeiras linhas têm produtor aqui: `dubbedOnly`
 * (do `opts`) e `seeds-playable` (há fonte tocável e o cachedOnly não está
 * ligado). `br-probe-pending` é transitório e agora é do worker — não entra.
 */
function seedsBlockedFact(streams: Stream[], dubbedOnly: boolean, cachedOnly: boolean): boolean {
  if (dubbedOnly) return true;
  if (cachedOnly) return false;
  for (const stream of streams) {
    const s = stream as { notice?: unknown; url?: unknown; infoHash?: unknown; externalUrl?: unknown } | null;
    if (!s || s.notice) continue;
    if ((typeof s.url === 'string' && s.url) || (typeof s.infoHash === 'string' && s.infoHash)) return true;
    if (typeof s.externalUrl === 'string' && s.externalUrl) return true;
  }
  return false;
}

/**
 * Hash apagado DE PROPÓSITO da conta (`adrm`) não é candidato: o enqueue o
 * recusa, e escolhê-lo prendia o Chupim no mesmo hash a cada busca. Mesma
 * exceção do enqueue — pronto no inventário destrava. Fato de KV: o módulo
 * (`alldebrid-reupload.ts`) sobrevive ao corte.
 */
function reuploadBlockedHere(apiKey: string, account: string, stream: Stream): boolean {
  if (!stream.infoHash || !reuploadBlocked(account, stream.infoHash)) return false;
  if (unblockIfInventoryReady(apiKey, account, stream.infoHash)) return false;
  metrics.count('autofetch.reupload-blocked-skipped');
  return true;
}

/**
 * Seleção: a cascata `br → any → seeds` é do NATIVO (`decideAutofetch`); aqui
 * ficam só os fatos que o lote não vê (morto, `adrm`, `seeds_blocked`) e o hold
 * de cada candidato imediato — antes da checagem, como sempre foi.
 */
export function oracleAutoFetchCandidates(
  streams: Stream[],
  { season }: CandidatesRequest = {},
): OracleCandidate[] {
  const user = opts();
  const adapter = rawAdapter();
  if (!adapter || !canAutoFetchBr({ autoFetchBr: user.autoFetchBr }, adapter)) return [];
  const live = autofetchLive.effective();
  const account = accountScope(user.debridApiKey);
  const adapterId = adapter.id;
  const liveStreams = streams.filter(
    (s) => (!s.infoHash || !autofetch.isDead(adapterId, account, s.infoHash))
      && !reuploadBlockedHere(user.debridApiKey, account, s),
  );

  // Política efetiva do runtime do usuário + operador (era `seedsPolicyConfig`,
  // em `autofetch-candidates.ts`, removido na B4): mapeamento de config, não regra.
  const policy = {
    dubbedOnly: user.dubbedOnly,
    cachedOnly: user.debridCachedOnly,
    maxSizeGb: user.maxSizeGb,
    seedsMaxGb: config.debrid.autoFetchSeedsMaxGb,
    seedsMaxQuality: config.debrid.autoFetchSeedsMaxQuality,
  };
  const queueDepth = live.autoFetchQueue ? live.autoFetchQueueDepth : 0;

  let pick: AutofetchPick<Stream>;
  try {
    pick = decideAutofetch({
      streams: liveStreams,
      season,
      queueDepth,
      live,
      policy,
      autoFetchBr: user.autoFetchBr,
      adapter,
      // `br-probe-pending` não tem produtor pós-corte: ver `seedsBlockedFact`.
      seedsBlocked: seedsBlockedFact(liveStreams, policy.dubbedOnly, policy.cachedOnly),
    });
  } catch (err) {
    // Sem decisão não há download: fecha sem candidato e a resposta segue.
    metrics.count('rust.autofetch.error');
    log.warn('[autofetch] seleção do Rust falhou; nenhum download nesta busca:', log.errorMessage(err));
    return [];
  }

  const immediate = pick.immediate.filter((row) => hasHash(row.stream));
  // Hold apenas nos candidatos imediatos que serão disparados — o mesmo ponto
  // do antigo `autoFetchCandidates` (ANTES da checagem de cache).
  for (const candidate of immediate) held.hold(String(candidate.stream.infoHash), live.autoFetchTtl, account);

  return immediate.map(({ stream, pool, rare, slotLimit }) => ({
    stream: stream as OracleStream,
    account,
    pool,
    ...(pool === 'seeds' ? { slotLimit: slotLimit ?? live.autoFetchTopSeedsMax, rare } : {}),
  }));
}

/** Desistência da busca inteira: todo hash volta à limpeza normal. */
export function oracleReleaseAllHolds(candidates: OracleCandidate[]): void {
  for (const { stream, account } of candidates) held.release(String(stream.infoHash || ''), account);
}

/** Motivo pelo qual um candidato não foi disparado (ordem do antigo classifyEnqueue). */
type SkipReason =
  | 'paused'
  | 'dead'
  | 'already-cached'
  | 'marker'
  | 'in-flight'
  | 'search-slot-busy'
  | 'account-gate'
  | 'budget';

/**
 * Espelho de `ENQUEUE_ROLLBACK` (`autofetch-gates.ts`, removido na B4) sem a
 * ação `obra`: a reserva F2 não existe deste lado. `in-flight` segue retendo o
 * hold de propósito — o MESMO hash está em voo agora, e soltá-lo reabriria o
 * hash à limpeza no meio do download.
 */
const ROLLBACK: Record<SkipReason, Array<'lock' | 'slot' | 'hold'>> = {
  paused: ['hold'],
  dead: ['hold'],
  'already-cached': ['hold'],
  marker: ['hold'],
  'in-flight': [],
  'search-slot-busy': ['lock', 'hold'],
  'account-gate': ['lock', 'slot', 'hold'],
  budget: ['lock', 'slot', 'hold'],
};

/**
 * Disparo de UM candidato, fire-and-forget (nunca no caminho da resposta):
 * portões na ordem do antigo `enqueueAutofetch`, trava em memória, vaga da
 * busca, orçamento, `enqueue` (play/actions.ts) e o efeito do aceite. `true` = saiu.
 */
function dispatchCandidate(candidate: OracleCandidate, req: PostCheckRequest): boolean {
  const adapter = rawAdapter() as DebridAdapter | null;
  if (!adapter) return false;
  const h = String(candidate.stream.infoHash || '').toLowerCase();
  if (!h) return false;
  const { account } = candidate;
  const { cached, season, episode, searchKey } = req;
  const live = autofetchLive.effective();
  const lockKey = autofetch.markerKey(adapter.id, account, h);

  const skip = (reason: SkipReason): false => {
    for (const action of ROLLBACK[reason]) {
      if (action === 'lock') autofetch.release(lockKey);
      else if (action === 'slot') { if (searchKey) autofetch.releaseSearchSlot(searchKey); }
      else held.release(h, account);
    }
    return false;
  };

  if (autofetchLive.isPaused()) return skip('paused');
  if (autofetch.isDead(adapter.id, account, h)) return skip('dead');
  if (cached.has(h)) return skip('already-cached');
  if (autofetch.markerActive(adapter.id, account, h)) return skip('marker');
  if (!autofetch.acquire(lockKey)) return skip('in-flight');
  const slotLimit = candidate.slotLimit
    ?? (candidate.pool === 'seeds' ? live.autoFetchTopSeedsMax : live.autoFetchMax);
  if (searchKey && !autofetch.acquireSearchSlot(searchKey, slotLimit)) return skip('search-slot-busy');
  if (accountGate.accountGateBlocked(adapter, opts().debridApiKey)) return skip('account-gate');
  if (!autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit)) return skip('budget');

  const stream = candidate.stream;
  // Pack de temporada: a identidade que vai ao serviço é por TEMPORADA (o
  // episódio sai nulo) — mesmo predicado do antigo `enqueueAutofetch`.
  const isPack = Boolean(live.autoFetchSeasonFill && adapter.cacheCheck
    && isSeasonPackFillEligible(stream, season ?? null));
  enqueue(h, { season, episode: isPack ? null : episode })
    .then((ok) => {
      autofetch.release(lockKey);
      if (ok) {
        // Marker no KV nativo: TTL do aceite/hold. O enqueue nativo grava a
        // forma SEM `obra`, e é essa que este oráculo reproduz.
        autofetch.setMarker(adapter.id, account, h, autofetch.markerValue(ok), live.autoFetchTtl);
        metrics.count('autofetch.enqueued');
        // Acervo retido: só o pool BR dublado do AllDebrid com flags reais
        // (nunca `_lied`) vira proteção durável — invariante 6.
        if (adapter.id === 'alldebrid' && candidate.pool === 'br'
          && Boolean(stream._br) && Boolean(stream._dubbed || stream._dubClaim || stream._bankDub)
          && !stream._lied) {
          held.protectBr(adapter.id, account, h);
        }
        log.info(`[autofetch] ${adapter.label} baixando ${candidate.pool}: ${String(stream.title || stream.name || '').split('\n')[0].slice(0, 70)}`);
      } else {
        if (searchKey) autofetch.releaseSearchSlot(searchKey);
        held.release(h, account);
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} não aceitou ${h}`);
      }
    })
    .catch((err) => {
      autofetch.release(lockKey);
      if (searchKey) autofetch.releaseSearchSlot(searchKey);
      held.release(h, account);
      log.warn('[autofetch] falhou:', err?.message || err);
    });
  return true;
}

/**
 * Despacho pós-cache: com o cache JÁ conhecido, decide o que ainda vale baixar
 * (o que os testes medem) e dispara. As paradas por pool são as mesmas do
 * antigo `autoFetchBrDubbed`/`applySeedsStopGate`; a FILA dessas entradas não
 * é escrita (escritor único = nativo).
 */
export function oracleAutoFetchBrDubbed(
  streams: Stream[],
  candidates: OracleCandidate[],
  req: PostCheckRequest,
): number {
  const adapter = rawAdapter() as DebridAdapter | null;
  if (!candidates || candidates.length === 0) return 0;
  // Sem resposta confiável de cache não há como saber o que falta.
  if (!req.known || !adapter) {
    oracleReleaseAllHolds(candidates);
    return 0;
  }
  const { cached } = req;
  const live = autofetchLive.effective();
  const pool = candidates[0].pool;
  let remaining = candidates;

  if (pool === 'any') {
    // Dublado tocável (BR ou global) para o any: o gringo ⚡ não substitui.
    if (hasCachedBrDubbed(streams, cached) || hasCachedAnyDubbed(streams, cached)) {
      oracleReleaseAllHolds(candidates);
      return 0;
    }
  } else if (pool === 'seeds') {
    // Política permanente do terceiro nível (`dubbedOnly`).
    if (opts().dubbedOnly) {
      oracleReleaseAllHolds(candidates);
      return 0;
    }
    // Parada por cache — `decideSeedsStop` (removido com a policy): dublado
    // tocável para sempre; qualquer cache para, salvo a exceção do título raro
    // (`rareOverCached` + regime raro + adapter com cacheCheck).
    if (hasCachedBrDubbed(streams, cached) || hasCachedAnyDubbed(streams, cached)) {
      oracleReleaseAllHolds(candidates);
      return 0;
    }
    if (cached.size > 0) {
      const rareOverCached = Boolean(candidates[0].rare)
        && live.autoFetchRareThreshold > 0
        && adapter.cacheCheck === true
        && config.debrid.autoFetchRareOverCached;
      if (!rareOverCached) {
        oracleReleaseAllHolds(candidates);
        return 0;
      }
      metrics.count('autofetch.seeds.rareOverCached');
      remaining = candidates.filter((c) => !cached.has(String(c.stream.infoHash || '').toLowerCase()));
      const vivos = new Set(remaining);
      for (const c of candidates) {
        if (!vivos.has(c)) held.release(String(c.stream.infoHash || ''), c.account);
      }
    }
  } else {
    // Pool br: cobertura POR qualidade-alvo. 720 Dual ⚡ não mata o 1080/4K;
    // unknown/SD para se já há QUALQUER BR dublado em cache.
    const covered = cachedBrDubbedTargetQualities(streams, cached, { season: req.season });
    const kept: OracleCandidate[] = [];
    for (const selected of candidates) {
      const q = streamQuality(selected.stream);
      const drop = isAutofetchTargetQuality(q)
        ? covered.has(q)
        : hasCachedBrDubbed(streams, cached);
      if (drop) {
        // Hold foi adquirido ANTES da checagem: o que a cobertura resolveu sai
        // um a um, senão o hash fica imune ao dropUncached.
        held.release(String(selected.stream.infoHash || ''), selected.account);
        continue;
      }
      kept.push(selected);
    }
    if (kept.length === 0) return 0;
    remaining = kept;
  }

  let enqueued = 0;
  for (const selected of remaining) {
    enqueued += dispatchCandidate(selected, req) ? 1 : 0;
  }
  return enqueued;
}
