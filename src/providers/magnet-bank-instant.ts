// Resposta INSTANTÂNEA pelo banco de magnets vivo.
//
// Motivação medida (VPS, 2026-09-18): a resposta p50 era 6,5s e 5,6s disso era
// espera da coleta BR ao vivo (bludv/nerdfilmes/comandotorrents raspando
// WordPress atrás do FlareSolverr). O índice `idx` acertava 6/9 buscas mas não
// economizava nada: `attemptIndexFastPath` ainda esperava o BR prioritário. O
// banco vivo (`data/magnets.db`) já tem uma foto confiável da obra, então a
// primeira abertura pode sair em ~1s com os itens do acervo (selo 📦/~N) e a
// coleta ao vivo roda inteira no tail, promovendo a lista pela próxima abertura.
//
// A janela de confiança é ADAPTATIVA por obra, não fixa: título estável (sem
// torrent novo há semanas) confia por até 7 dias; obra que ainda ganha release
// a cada coleta confia por ~1h e quase sempre vai ao vivo. Cada abertura roda a
// coleta real por trás e renova `lastSeen`, então título aberto com frequência
// fica sempre instantâneo sem esconder lançamento novo.
//
// Travas (as mesmas da Etapa 4, com UMA diferença deliberada):
// - `fromFallback: true` → selo 📦/~N e exclusão automática de captura do
//   banco, `releaseIndex.record`, autofetch/warmer e auditoria de áudio;
// - item passa pelo MESMO `buildStreams` (título/episódio/multiobra, mag
//   bad/lie, debrid, cotas, MIN_SEEDERS) — sem bypass;
// - **`passed_filter=1` OU fonte index-only é ELEGIBILIDADE** (diferente do
//   fallback, que aceita 0): a resposta instantânea só entrega a foto que JÁ
//   sobreviveu a uma busca viva; palpite do site que nunca passou pelo filtro
//   não vira 📦 — EXCETO o só-colhedor (index-only), que não passa pela busca
//   viva e por isso fica com `passed_filter=0` para sempre; o acervo é a porta;
// - fail-open: qualquer falha do banco devolve inelegível e a busca segue ao
//   vivo — nunca derruba a resposta.
import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import { worksForObraMany, sourcesForMany } from '../utils/magnet-bank-query.js';
import { hashOf, isOpen as bankIsOpen } from '../utils/magnet-bank.js';
import type { MagnetRow, WorkRow } from '../utils/magnet-bank.js';
import { obraTargets, pickSource, toRawItem, PER_INDEXER_MAX } from './magnet-bank-fallback.js';
import type { Candidate } from './magnet-bank-fallback.js';
import { idxPoolCovered, poolCovered } from './search-pool-coverage.js';
import { allowedSourceIndexer } from './allowed-source-indexer.js';
import { audioFromTitle, looksPtBr } from '../utils/audio-quality.js';
import { fuseIndexEnrichment } from './index-evidence.js';
import { filterRelevantRaw } from '../utils/release-filters.js';
import type { LiveIndexerState } from './live-indexer-state.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

/** Sinal de catálogo disponível para a regra de lançamento recente. */
export interface InstantMeta {
  /** Ano de catálogo (pode vir com sufixo, ex. "2024–"). */
  year?: string | number | null;
  /** Data de lançamento do filme (ISO), quando o metadado carrega. */
  released?: string | null;
  /** Data de exibição do episódio (ISO), quando o metadado carrega. */
  firstAired?: string | null;
}

export interface InstantWindow {
  windowMs: number;
  /** Maior `lastSeen` de obra com `passed_filter=1` (0 = nunca houve coleta viva). */
  lastCollection: number;
  /** Maior `firstSeen` — quando o banco descobriu o torrent mais novo da obra. */
  newest: number;
  /** `lastCollection − newest`: há quanto tempo as coletas não trazem novidade. */
  stability: number;
  /** Lançamento recente: a janela sofre o teto curto. */
  fresh: boolean;
}

export interface InstantRequest {
  type: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  meta?: InstantMeta | null;
  /** Usuário pediu dublado: só instantâneo se o acervo cobre o pool dublado. */
  preferDubbed: boolean;
  /** Releases da obra já no índice: evidência melhor — excluídas e somadas. */
  indexReleases?: readonly any[];
  /** Injetável para teste determinístico. */
  now?: number;
  /** Contexto de matching para reaplicar o filtro (série/pack/CAM). */
  names?: string[];
  isSeries?: boolean;
  year?: number | string | null;
}

export type InstantSkipReason =
  | 'disabled'
  | 'no-live-collection'
  | 'stale'
  | 'not-covered'
  | 'no-dubbed'
  | 'error';

export interface InstantResult {
  eligible: boolean;
  items: RawItem[];
  windowMs: number;
  reason?: InstantSkipReason;
}

const DAY_MS = 86400000;
const FRESH_MOVIE_MS = 30 * DAY_MS;
const FRESH_EPISODE_MS = 14 * DAY_MS;

const asTime = (value: unknown): number => {
  const text = String(value || '');
  if (!text) return 0;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Lançamento recente → teto de 2h na janela. Usa `released`/`firstAired` quando
 * o metadado carrega a data; sem ela, cai no sinal grosseiro disponível (ano de
 * catálogo corrente), que é conservador: encurta a janela, nunca a estende.
 *
 * Limitação conhecida em SÉRIE: `firstAired` é a data do EPISÓDIO pedido
 * (extraída de `videos` pelo Cinemeta e ligada no `matchContext`), não a estreia
 * da série. Obra cujo `videos` não publica data cai no sinal de ANO da série —
 * que é velho — e o episódio novo NÃO sofre o teto curto. Nesse caso quem
 * protege é a própria estabilidade: toda abertura instantânea dispara a coleta
 * completa no tail, então a janela de 1h do piso é reavaliada na próxima.
 */
export function isRecentRelease(meta: InstantMeta | null | undefined, now = Date.now()): boolean {
  if (!meta) return false;
  const released = asTime(meta.released);
  if (released && now >= released && now - released <= FRESH_MOVIE_MS) return true;
  const firstAired = asTime(meta.firstAired);
  if (firstAired && now >= firstAired && now - firstAired <= FRESH_EPISODE_MS) return true;
  const year = Number(String(meta.year ?? '').slice(0, 4));
  return Number.isFinite(year) && year >= new Date(now).getUTCFullYear();
}

/**
 * Janela adaptativa: `clamp(estabilidade ÷ 2, min, max)`, onde estabilidade é
 * `ultimaColeta − ultimaNovidade`. Quanto mais tempo as coletas não trazem
 * torrent novo, mais tempo a foto do acervo vale. O lançamento recente sofre o
 * teto curto porque uma estreia pode ainda ganhar release a qualquer hora.
 */
export function instantWindow(
  works: readonly WorkRow[],
  meta: InstantMeta | null | undefined,
  now = Date.now(),
): InstantWindow {
  let lastCollection = 0;
  let newest = 0;
  for (const work of works || []) {
    if (!work) continue;
    if (work.passedFilter === 1 && work.lastSeen > lastCollection) lastCollection = work.lastSeen;
    if (work.firstSeen > newest) newest = work.firstSeen;
  }
  const stability = Math.max(0, lastCollection - newest);
  const minMs = Math.max(1, config.magnetBank.instantMinMs);
  const maxMs = Math.max(minMs, config.magnetBank.instantMaxMs);
  let windowMs = Math.min(maxMs, Math.max(minMs, Math.floor(stability / 2)));
  const fresh = isRecentRelease(meta, now);
  if (fresh) windowMs = Math.min(windowMs, Math.max(1, config.magnetBank.instantFreshMaxMs));
  return { windowMs, lastCollection, newest, stability, fresh };
}

/**
 * Inelegível com o motivo no contador `search.bank.instant.skip.<motivo>` — é o
 * par de `search.bank.instant` no `/metrics.json` que diz POR QUE a via não
 * respondeu (janela vencida, cobertura, dublado, erro).
 */
const empty = (reason: InstantSkipReason, windowMs = 0): InstantResult => {
  metrics.count(`search.bank.instant.skip.${reason}`);
  return { eligible: false, items: [], windowMs, reason };
};

/**
 * Monta a reserva instantânea da obra. Devolve `eligible:false` com motivo em
 * qualquer uma das travas; `items` já vem com `fromFallback` (selo e exclusões).
 */
export function collectInstantItems(req: InstantRequest): InstantResult {
  const now = req.now ?? Date.now();
  try {
    if (!config.magnetBank?.enabled || !config.magnetBank?.instantEnabled) return empty('disabled');
    const imdbId = String(req.imdbId || '');
    if (!imdbId.startsWith('tt')) return empty('disabled');
    // Leitura QUIET: um processo que nunca abriu o banco (testes, instância que
    // não exercitou a captura) NÃO pode criar `data/magnets.db` só para
    // responder. O boot de produção abre via `openIfEnabled`; sem engine aberto
    // não existe coleta viva, então a via segue ao vivo.
    if (!bankIsOpen()) return empty('no-live-collection');

    const perIndexerMax = Math.max(1, Math.min(PER_INDEXER_MAX, Math.trunc(config.magnetBank.fallbackMaxPerIndexer) || PER_INDEXER_MAX));
    const globalMax = Math.max(1, Math.min(500, Math.trunc(config.magnetBank.fallbackGlobalMax) || 40));
    const readLimit = Math.min(200, Math.max(globalMax, perIndexerMax) * 2);
    const maxTotal = globalMax * 3;

    const rows = worksForObraMany(imdbId, obraTargets(req.type, req.season, req.episode), readLimit, maxTotal);
    const works: WorkRow[] = [];
    for (const row of rows) if (row.work) works.push(row.work);
    const win = instantWindow(works, req.meta, now);
    if (!win.lastCollection) return empty('no-live-collection', win.windowMs);
    if (now - win.lastCollection > win.windowMs) return empty('stale', win.windowMs);

    // Seleção: qualquer source do banco (não há "indexer falho" aqui), sem
    // lied, dedupe por hash, cap por indexer e global. Elegibilidade:
    // `passed_filter=1` (a foto que sobreviveu ao filtro vivo; o fallback da
    // Etapa 4 aceita 0 porque é rede de emergência) OU fonte index-only — o
    // só-colhedor nunca passa pela busca viva, então o passedFilter dele fica
    // 0 para sempre e o acervo é a única porta dele. A checagem desce para
    // depois do filtro de config (`allowed`): é por fonte, não pela obra.
    const indexOnlySet = new Set(config.jackett.indexOnlyIndexers.map((id) => String(id).trim().toLowerCase()));
    const magnets = new Map<string, MagnetRow>();
    const worksByHash = new Map<string, WorkRow>();
    for (const row of rows) {
      const magnet = row.magnet;
      if (!magnet || !row.work || !magnet.hash) continue;
      if (magnet.lied) continue;
      if (magnets.has(magnet.hash)) {
        // O MESMO magnet tem até três linhas na obra — episódio, temporada e
        // obra raiz — e `obraTargets` lê o EPISÓDIO primeiro. O pack achado na
        // busca do episódio fica `passed_filter=0` nessa linha mesmo quando a
        // busca da TEMPORADA o validou em (S,-1)=1: ficar com a primeira linha
        // tornava inelegível um magnet que o acervo tem como confirmado e ele
        // SUMIA da reserva instantânea. Preferir a linha medida (1) resolve sem
        // tocar no dedupe por hash, no `lied` nem na janela — que continua
        // lendo TODAS as linhas.
        const prior = worksByHash.get(magnet.hash);
        if (prior && prior.passedFilter !== 1 && row.work.passedFilter === 1) {
          worksByHash.set(magnet.hash, row.work);
        }
        continue;
      }
      magnets.set(magnet.hash, magnet);
      worksByHash.set(magnet.hash, row.work);
    }
    // O idx tem evidência melhor que o acervo: hash já indexado não vira 📦.
    const exclude = new Set<string>();
    for (const release of req.indexReleases || []) {
      const hash = hashOf({ infoHash: release?.hash });
      if (hash) exclude.add(hash);
    }
    const sourcesByHash = sourcesForMany([...magnets.keys()]);
    const candidates: Candidate[] = [];
    for (const [hash, magnet] of magnets) {
      if (exclude.has(hash)) {
        metrics.count('search.bank.instant.skip.idx-hash');
        continue;
      }
      const allowed = (sourcesByHash.get(hash) || []).filter((s) => allowedSourceIndexer(s.indexer));
      const work = worksByHash.get(hash)!;
      const eligible = work.passedFilter === 1
        || allowed.some((s) => indexOnlySet.has(String(s.indexer || '').trim().toLowerCase()));
      if (!eligible) continue;
      const source = pickSource(allowed, new Set(), true);
      if (!source) continue;
      candidates.push({ magnet, source, work });
    }
    // Quem prefere dublado recebe o dublado do acervo ANTES do teto: ordenar só
    // por seeders deixava o global mais semeado ocupar a vaga e cortava o
    // dublado que o banco tinha. `magnet.dubbed` não é confiável (a captura não
    // classifica áudio), então a leitura é pelo título, com a régua BR de sempre.
    const dubRank = (m: MagnetRow) => {
      if (!req.preferDubbed) return 0;
      const audio = audioFromTitle(m.title || '');
      return looksPtBr(m.title || '') || (m.isBr && (audio === 'Dublado' || audio === 'Dual' || audio === 'Nacional')) ? 0 : 1;
    };
    candidates.sort((a, b) => {
      const dub = dubRank(a.magnet) - dubRank(b.magnet);
      if (dub !== 0) return dub;
      if (b.magnet.seedersMax !== a.magnet.seedersMax) return b.magnet.seedersMax - a.magnet.seedersMax;
      return b.magnet.lastSeen - a.magnet.lastSeen;
    });

    const items: RawItem[] = [];
    const perIndexer = new Map<string, number>();
    for (const candidate of candidates) {
      if (items.length >= globalMax) break;
      const indexerId = String(candidate.source.indexer || '').trim().toLowerCase() || 'unknown';
      const used = perIndexer.get(indexerId) || 0;
      if (used >= perIndexerMax) continue;
      perIndexer.set(indexerId, used + 1);
      items.push(toRawItem(candidate));
    }
    // Reaplica o filtro vivo nos itens do banco: o `passed_filter=1` grava a
    // elegibilidade NA HORA da busca que capturou, mas regras mudam (série no
    // filme, TS/PreDVD, pack fora do intervalo). Sem reaplicar, a lista errada
    // sobrevive por até 7 dias no acervo. Barato: filtro é puro e os itens já
    // estão em memória. Se o req não tem nomes, o filtro é no-op (names=[]).
    const matchContext = {
      names: req.names || [],
      year: req.year ?? req.meta?.year ?? null,
      isSeries: req.isSeries ?? (req.type === 'series'),
      season: req.season,
      episode: req.episode,
    };
    const filteredItems = req.names?.length
      ? filterRelevantRaw(items, matchContext)
      : items;
    // Sem foto confiável não há via instantânea: nenhum candidato elegível
    // (nem `passed_filter=1`, nem index-only) — o caminho vivo decide.
    if (filteredItems.length === 0) return empty('no-live-collection', win.windowMs);

    // Cobertura: os itens JÁ CORTADOS (pós caps por indexer/global) somados ao
    // idx. Calcular sobre a pré-seleção prometia cobertura por item que o teto
    // descartou — a lista podia sair sem nada dublado e ainda dizer "coberto".
    // Episódio exige release que NOMEIE o episódio (pack sozinho não cobre).
    // `countMetrics:false`: esta é a via do BANCO; o funil `search.idx.*`
    // (inclusive `packOnly`) não pode ser poluído por ela.
    const coverage = [...filteredItems, ...(req.indexReleases || [])];
    if (!idxPoolCovered(coverage, { season: req.season, episode: req.episode, countMetrics: false })) return empty('not-covered', win.windowMs);
    // Sem dublado no acervo NÃO trava mais a via: a última coleta viva (dentro da
    // janela) já procurou e não achou, e esperar ~5-7s de BR ao vivo a cada
    // abertura quase sempre confirmava o mesmo (Angel Heart/Chinatown,
    // 2026-09-18). O tail segue buscando; dublado novo entra na abertura seguinte.
    if (req.preferDubbed && !poolCovered(coverage, { season: req.season, requireDubbed: true })) {
      metrics.count('search.bank.instant.noDubbed');
    }

    metrics.count('search.bank.instant');
    metrics.observe('search.bank.instant.windowMs', win.windowMs);
    log.info(`[instant] ${filteredItems.length} item(ns) do banco para ${imdbId} (janela ${Math.round(win.windowMs / 60000)}min)`);
    return { eligible: true, items: filteredItems, windowMs: win.windowMs };
  } catch (err: unknown) {
    log.warn('[instant] banco de magnets falhou; seguindo ao vivo:', log.errorMessage(err));
    return empty('error');
  }
}

/**
 * "Vivo vence sempre" no tail: remove do lote TODA a ponte 📦 da resposta
 * instantânea antes do rebuild. O `finish`/`late` reavalia pelo estado vivo e o
 * `collectFallbackForBuild` só devolve 📦 para indexer que AINDA falhou; um
 * item do acervo que a coleta reencontrou ou superou não pode manter a marca
 * (senão a lista promovida exibiria 📦 para release viva). Devolve quantos
 * saíram.
 */
export function dropInstantFallbacks(items: any[]): number {
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.fromFallback) {
      items.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * A foto do idx fica no lote (é a mesma release do índice de sempre) e perde o
 * selo 📦 quando o indexer DELA respondeu à coleta completa — a mesma régua do
 * fallback. Indexer que falhou (ou `/all` falho) mantém o selo: medido com o
 * Jackett parado (2026-09-18), limpar tudo gravava a foto como lista viva
 * completa, com `max-age=900` e seeders sem `~`. Devolve quantas marcas saíram
 * — com alguma, a lista precisa ser RECONSTRUÍDA, senão a promoção sem novidade
 * gravaria a lista antiga com o selo e TTL cheio.
 */
export function clearInstantSnapshots(items: any[], live: LiveIndexerState | null = null): number {
  const allFailed = Boolean(live?.allFailed());
  const failed = live ? live.failedIndexers() : new Set<string>();
  let cleared = 0;
  for (const item of items) {
    if (!item?.fromSnapshot) continue;
    const indexer = String(item.indexer || '').trim().toLowerCase();
    if (allFailed || failed.has(indexer)) continue;
    delete item.fromSnapshot;
    cleared += 1;
  }
  return cleared;
}

/**
 * Fecha o tail de uma resposta instantânea: derruba a ponte 📦, funde a
 * novidade viva e entrega ao `late` do orchestrator — que promove quando há
 * novidade e invalida a reserva quando o vivo respondeu sem falha. Fica aqui
 * (e não no facade) para o `search-orchestrator.ts` respeitar a catraca de 400
 * linhas. Devolve o estado vivo UNIFICADO: o `refresh` de debrid e o pack tardio
 * da mesma busca precisam dele para o `collectFallbackForBuild` REINJETAR a
 * reserva 📦 dos indexers que continuam falhos (sem isso o refresh regravava
 * uma lista sem reserva, ou vazia, promovendo TTL longo indevido).
 */
export async function promoteInstantTail(args: {
  rawItems: any[];
  liveItems: any[];
  live: LiveIndexerState | null;
  phase: number;
  late: (items: any[], grew: boolean, phase: any, partial?: boolean, live?: LiveIndexerState | null) => any;
}): Promise<LiveIndexerState | null> {
  const dropped = dropInstantFallbacks(args.rawItems);
  if (dropped > 0) metrics.count('search.bank.instant.dropped', dropped);
  const cleared = clearInstantSnapshots(args.rawItems, args.live);
  const { fresh } = fuseIndexEnrichment(args.rawItems, args.liveItems);
  if (fresh.length) {
    log.info(`[search] instantâneo: ${fresh.length} resultado(s) vivo(s) novo(s); promovendo`);
    args.rawItems.push(...fresh);
  }
  await args.late(args.rawItems, fresh.length > 0 || cleared > 0, args.phase, false, args.live);
  return args.live;
}
