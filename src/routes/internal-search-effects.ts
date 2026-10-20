// Rotas internas de ESCRITA E EFEITOS da busca (Fase A, passo 2 da migração
// strangler Node→Rust): POST /internal/search/index-write e
// POST /internal/search/effects. É o que o orquestrador Rust (`adom-search`)
// pede ao Node DEPOIS do `collect`: gravar o que a coleta provou e disparar os
// efeitos de fundo que ainda moram aqui (autofetch, warmer, auditoria, sonda,
// colhedor, chave de temporada).
//
// Mesmo padrão do `collect` (internal-search.ts): sem config na URL — o usuário
// vem no CORPO (`encoded`), e o contexto é restaurado com `runtime.run` (o
// `capture()` cobre o invariante de timer/promise pós-request). A diferença é o
// prazo: index-write é síncrono com contagens; effects é fire-and-forget — a
// resposta (202) NUNCA depende do efeito rodar.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import { record } from '../utils/release-index.js';
import type { ObraLocation } from '../utils/release-index-types.js';
import { markBankFilterOutcome } from '../providers/magnet-bank-hook.js';
import type { WorkCtx } from '../utils/magnet-bank.js';
import { enqueueAutofetch } from '../providers/autofetch-runner.js';
import { queueRdWarmForRelevant } from '../providers/harvest-warmer.js';
import { queueDubAudit } from '../providers/dub-audit.js';
import { requestBrProbe } from '../providers/br-probe.js';
import * as harvestQueue from '../providers/harvest-queue.js';
import { registerSeasonSearchKey } from '../providers/autofetch-season-index.js';
import { runAutofetchBatch } from '../providers/autofetch-batch.js';
import type { AutofetchBatchPayload } from '../providers/autofetch-batch.js';
import * as runtime from '../runtime.js';
import * as log from '../utils/logger.js';

// Tetos de entrada: a rota recebe LOTES pós-filtro, não acervo inteiro. Sem
// teto, um chamador bugado transformaria a escrita em varredura do disco.
const MAX_RELEASE_ENTRIES = 200;
const MAX_ITEMS_PER_ENTRY = 2000;
const MAX_EFFECTS = 100;
/** Lote do Chupim: o pool pós-debrid é `maxResults × candidatePoolFactor`
 *  (100 × 4 no teto do SCHEMA), com folga. */
const MAX_AUTOFETCH_ITEMS = 400;

const IMDB_RE = /^tt\d+$/;

/** Colaboradores trocáveis em teste (mesmo padrão do internal-search.ts). */
export interface InternalSearchEffectsCollaborators {
  /** Grava o lote pós-filtro no índice de releases (`releaseIndex.record`). */
  record: typeof record;
  /** Resultado do filtro de título na obra do banco de magnets. */
  markBankFilterOutcome: typeof markBankFilterOutcome;
  /** Enfileira candidato do Chupim (fila persistente; worker próprio drena). */
  enqueueAutofetch: typeof enqueueAutofetch;
  /** Alimenta o warmer do RD com as releases relevantes do lote. */
  queueRdWarmForRelevant: typeof queueRdWarmForRelevant;
  /** Enfileira candidatos BR em cache para interrogatório de áudio. */
  queueDubAudit: typeof queueDubAudit;
  /** Sonda dirigida BR (colheita com `brProbe: true`). */
  requestBrProbe: typeof requestBrProbe;
  /** Enfileira obra no colhedor (fila `harvest:v1:q`). */
  harvestEnqueue: typeof harvestQueue.enqueue;
  /** LRU de temporadas com pack pronto (Season Pack Fill). */
  registerSeasonSearchKey: typeof registerSeasonSearchKey;
  /** Lote pós-debrid do Chupim: reconstrói os streams e roda a cascata do Node. */
  runAutofetchBatch: typeof runAutofetchBatch;
}

type ReleaseEntry = {
  imdb: string; season: number | null; episode: number | null;
  items: any[]; entered: any[] | null; survivors: any[] | null; source?: 'autofetch';
};

/** Forma um lote de índice do corpo; string de erro = 400 no handler. */
function parseReleaseEntries(raw: unknown): { ok: true; entries: ReleaseEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'releases deve ser array' };
  if (raw.length > MAX_RELEASE_ENTRIES) {
    return { ok: false, error: `releases acima do teto de ${MAX_RELEASE_ENTRIES}` };
  }
  const entries: ReleaseEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `releases[${i}] deve ser objeto` };
    }
    const imdb = typeof item.imdb === 'string' ? item.imdb.trim() : '';
    if (!IMDB_RE.test(imdb)) return { ok: false, error: `releases[${i}].imdb deve começar com tt<dígitos>` };
    const season = typeof item.season === 'number' && Number.isInteger(item.season) ? item.season : null;
    const episode = typeof item.episode === 'number' && Number.isInteger(item.episode) ? item.episode : null;
    const items = item.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS_PER_ENTRY) {
      return { ok: false, error: `releases[${i}].items deve ser array (teto ${MAX_ITEMS_PER_ENTRY})` };
    }
    const entered = Array.isArray(item.entered) ? item.entered : null;
    const survivors = Array.isArray(item.survivors) ? item.survivors : null;
    const source = item.source === 'autofetch' ? 'autofetch' as const : undefined;
    entries.push({ imdb, season, episode, items, entered, survivors, source });
  }
  return { ok: true, entries };
}

/**
 * POST /internal/search/index-write — `{ encoded, releases: [...] }` →
 * `{ ok, recorded, entries, bank_marked, failed }`.
 *
 * Cada entrada tem `imdb` (+ `season`/`episode` opcionais), `items` (o lote CRU
 * pós-`filterRelevantRaw`) e, opcionalmente, `entered`/`survivors` (o antes/depois
 * do filtro de título; ausentes, `items` vale para os dois). Idempotente por
 * chamada: o `record` faz merge por hash (mais recente vence) — repetir o lote
 * não duplica nada. NUNCA lança: falha de entrada vira `failed` na contagem e
 * o log `[internal]` fica com o detalhe; só um erro fora do laço (bug) vira 500.
 */
async function handleIndexWrite(
  services: AppServices,
  deps: InternalSearchEffectsCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { releases?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });
  const parsed = parseReleaseEntries(body?.releases);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });

  let recorded = 0;
  let bankMarked = 0;
  let failed = 0;
  // Indexação é ESCRITA DE DISCO (idx + banco de magnets) e roda dentro do
  // contexto do usuário (`runtime.run`): o banco é por conta, e o invariante é
  // a preferência do usuário nunca vir do `.env` — mesmo fora do /stream.
  try {
    await services.runtime.run({ opts: target.opts, encoded: target.encoded }, async () => {
      for (const entry of parsed.entries) {
        try {
          const location: ObraLocation = { season: entry.season, episode: entry.episode };
          recorded += deps.record(entry.imdb, location, entry.items, { source: entry.source });
          const ctx: WorkCtx = { imdbId: entry.imdb, season: entry.season, episode: entry.episode };
          const entered = entry.entered ?? entry.items;
          const survivors = entry.survivors ?? entry.items;
          if (deps.markBankFilterOutcome(entered, survivors, ctx)) bankMarked += 1;
        } catch (err) {
          // Falha de UMA entrada não derruba o lote: contabiliza e segue.
          failed += 1;
          log.error(`[internal] index-write ${entry.imdb}: entrada falhou:`, err);
        }
      }
    });
    log.debug(`[internal] index-write: entries=${parsed.entries.length} recorded=${recorded} bank=${bankMarked} failed=${failed}`);
    return res.json({ ok: true, recorded, entries: parsed.entries.length, bank_marked: bankMarked, failed });
  } catch (err) {
    log.error('[internal] index-write falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao gravar o índice' });
  }
}

/** Efeito conhecido: `kind` discriminado + payload já validado por tipo. */
type Effect = { kind: string; payload: Record<string, unknown> };

/**
 * Valida o lote de efeitos. Cada `kind` tem forma própria de payload — validar
 * aqui (400 no rejeitado como um todo, `rejected` no parcial) evita que um
 * payload malformado vire exceção assíncrona num timer, longe do chamador.
 */
function parseEffects(raw: unknown): { accepted: Effect[]; rejected: number } {
  const accepted: Effect[] = [];
  let rejected = 0;
  if (!Array.isArray(raw)) return { accepted, rejected: 0 };
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    const kind = typeof item?.kind === 'string' ? item.kind : '';
    const payload = (item?.payload && typeof item.payload === 'object' && !Array.isArray(item.payload))
      ? item.payload as Record<string, unknown> : null;
    const okShape = (() => {
      if (!payload) return false;
      switch (kind) {
        case 'autofetch':
          return Boolean(payload.candidate && payload.request
            && typeof payload.candidate === 'object' && typeof payload.request === 'object');
        case 'autofetch_batch':
          // O lote em si é sanitizado no handler (`streamOfItem`); aqui só a
          // forma grosseira, para um payload sem lista não virar varredura.
          return Array.isArray(payload.items)
            && payload.items.length <= MAX_AUTOFETCH_ITEMS
            && Array.isArray(payload.cached)
            && payload.cached.length <= MAX_AUTOFETCH_ITEMS
            && typeof payload.known === 'boolean';
        case 'rd_warmer':
          return Array.isArray(payload.releases);
        case 'dub_audit':
          return typeof payload.adapter_id === 'string' && typeof payload.api_key === 'string'
            && Array.isArray(payload.candidates);
        case 'br_probe':
          return typeof payload.imdbId === 'string' && IMDB_RE.test(payload.imdbId)
            && (payload.type === 'movie' || payload.type === 'series');
        case 'harvester_enqueue':
          return typeof payload.imdbId === 'string' && IMDB_RE.test(payload.imdbId)
            && typeof payload.reason === 'string';
        case 'season_key':
          return typeof payload.adapter_id === 'string' && typeof payload.account === 'string'
            && typeof payload.imdb === 'string' && IMDB_RE.test(payload.imdb)
            && typeof payload.season === 'number' && typeof payload.cache_key === 'string';
        default:
          return false; // kind desconhecido: rejeitado, nunca lança
      }
    })();
    if (okShape && payload) accepted.push({ kind, payload });
    else rejected += 1;
  }
  return { accepted, rejected };
}

/** Executa UM efeito aceito. Cada função enfileira e volta — nada bloqueia. */
function runEffect(deps: InternalSearchEffectsCollaborators, effect: Effect): void {
  const p = effect.payload;
  switch (effect.kind) {
    case 'autofetch':
      deps.enqueueAutofetch(p.candidate as any, p.request as any);
      return;
    case 'autofetch_batch':
      deps.runAutofetchBatch(p as AutofetchBatchPayload);
      return;
    case 'rd_warmer':
      deps.queueRdWarmForRelevant(p.releases as any[]);
      return;
    case 'dub_audit':
      deps.queueDubAudit(
        String(p.adapter_id), String(p.api_key), p.candidates as any[],
        typeof p.search_key === 'string' ? p.search_key : null,
      );
      return;
    case 'br_probe': {
      const result = deps.requestBrProbe(p as any, p.mode === 'upgrade' ? { mode: 'upgrade' } : {});
      // Sonda INELEGÍVEL (kill-switch/retry/estado) devolve `fallbackBrGap`:
      // o follow-up do índice manda a obra ao colhedor (`br-gap`), a MESMA
      // rede que o `enqueueIndexFollowUp` do TS preserva. Sonda agendada já
      // enfileirou por dentro do `requestBrProbe` — aqui não duplica.
      if (result?.fallbackBrGap) {
        deps.harvestEnqueue({
          imdbId: String(p.imdbId),
          type: p.type === 'series' ? 'series' : 'movie',
          season: typeof p.season === 'number' ? p.season : null,
          episode: typeof p.episode === 'number' ? p.episode : null,
          reason: 'br-gap',
        });
      }
      return;
    }
    case 'harvester_enqueue':
      deps.harvestEnqueue(p as any);
      return;
    case 'season_key':
      deps.registerSeasonSearchKey(
        String(p.adapter_id), String(p.account), String(p.imdb),
        Number(p.season), String(p.cache_key),
      );
      return;
  }
}

/**
 * POST /internal/search/effects — fire-and-forget. `{ encoded, effects: [...] }`
 * → **202** `{ ok, accepted, rejected }` na HORA: o prazo da resposta nunca
 * depende do efeito (só enfileiramento, os workers próprios drenam). Falha de
 * um efeito não afeta os outros — log por efeito, sem exceção cruzando o timer.
 */
function handleEffects(
  services: AppServices,
  deps: InternalSearchEffectsCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { effects?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });
  if (!Array.isArray(body?.effects)) return res.status(400).json({ ok: false, error: 'effects deve ser array' });
  if (body.effects.length > MAX_EFFECTS) {
    return res.status(400).json({ ok: false, error: `effects acima do teto de ${MAX_EFFECTS}` });
  }
  const { accepted, rejected } = parseEffects(body.effects);
  // Contexto do usuário para os timers: `capture()` cumpre o invariante do
  // AGENTS.md (timer pós-request precisa de capture + run); nas rotas internas
  // a store vem VAZIA, então o patch carrega o `encoded` do corpo — a origem
  // certa da preferência do usuário, nunca o `.env`.
  const captured = runtime.capture();
  const ctx = { ...(captured || {}), opts: target.opts, encoded: target.encoded };
  for (const effect of accepted) {
    // setImmediate: a resposta sai primeiro; o `run` restaura a conta mesmo
    // longe da requisição (a drenagem da auditoria, por exemplo, agenda outra
    // drenagem dentro dela e herda o ALS daqui).
    setImmediate(() => {
      try {
        runtime.run(ctx, () => runEffect(deps, effect));
        log.debug(`[internal] effect ${effect.kind}: enfileirado`);
      } catch (err) {
        log.error(`[internal] effect ${effect.kind} falhou:`, err);
      }
    });
  }
  log.debug(`[internal] effects: accepted=${accepted.length} rejected=${rejected}`);
  return res.status(202).json({ ok: true, accepted: accepted.length, rejected });
}

/**
 * Registra as rotas de escrita/efeitos. Chamado por `registerInternalSearch`,
 * junto das rotas de leitura (montadas ANTES do overlay `/:userConfig`).
 */
export function registerInternalSearchEffects(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalSearchEffectsCollaborators> = {},
): void {
  const deps: InternalSearchEffectsCollaborators = {
    record: overrides.record ?? record,
    markBankFilterOutcome: overrides.markBankFilterOutcome ?? markBankFilterOutcome,
    enqueueAutofetch: overrides.enqueueAutofetch ?? enqueueAutofetch,
    queueRdWarmForRelevant: overrides.queueRdWarmForRelevant ?? queueRdWarmForRelevant,
    queueDubAudit: overrides.queueDubAudit ?? queueDubAudit,
    requestBrProbe: overrides.requestBrProbe ?? requestBrProbe,
    harvestEnqueue: overrides.harvestEnqueue ?? harvestQueue.enqueue,
    registerSeasonSearchKey: overrides.registerSeasonSearchKey ?? registerSeasonSearchKey,
    runAutofetchBatch: overrides.runAutofetchBatch ?? runAutofetchBatch,
  };
  const json = express.json({ limit: '1mb' });

  router.post('/internal/search/index-write', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleIndexWrite(services, deps, req, res);
  }));

  router.post('/internal/search/effects', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleEffects(services, deps, req, res);
  }));
}
