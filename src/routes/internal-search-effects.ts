// Rotas internas de ESCRITA E EFEITOS da busca (Fase A, passo 2 da migração
// strangler Node→Rust): POST /internal/search/effects. É o que o orquestrador
// Rust (`adom-search`) pede ao Node DEPOIS do `collect`: disparar os efeitos de
// fundo que ainda moram aqui (autofetch, warmer, auditoria, sonda, colhedor,
// chave de temporada) e capturar no banco VIVO o que a coleta NATIVA viu
// (`magnet_capture`). O índice e a leitura do banco de magnets são NATIVOS
// desde o R4 — a antiga rota `index-write` foi removida junto com os ramos Node.
//
// Mesmo padrão do `collect` (internal-search.ts): sem config na URL — o usuário
// vem no CORPO (`encoded`), e o contexto é restaurado com `runtime.run` (o
// `capture()` cobre o invariante de timer/promise pós-request). effects é
// fire-and-forget — a resposta (202) NUNCA depende do efeito rodar.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import { enqueueAutofetch } from '../providers/autofetch-runner.js';
import { queueRdWarmForRelevant } from '../providers/harvest-warmer.js';
import { queueDubAudit } from '../providers/dub-audit.js';
import { requestBrProbe } from '../providers/br-probe.js';
import { enqueueNativeHarvest } from '../utils/harvest-native.js';
import type { NativeHarvestEnqueue } from '../utils/harvest-native.js';
import { registerSeasonSearchKey } from '../providers/autofetch-season-index.js';
import { runAutofetchBatch } from '../providers/autofetch-batch.js';
import type { AutofetchBatchPayload } from '../providers/autofetch-batch.js';
import { captureItems } from '../utils/magnet-bank.js';
import type { WorkCtx } from '../utils/magnet-bank.js';
import type { RawItem } from '../../types/domain.js';
import * as runtime from '../runtime.js';
import * as log from '../utils/logger.js';

// Teto de entrada: a rota recebe um lote de efeitos, nunca acervo inteiro.
const MAX_EFFECTS = 100;
/** Lote do Chupim: o pool pós-debrid é `maxResults × candidatePoolFactor`
 *  (100 × 4 no teto do SCHEMA), com folga. */
const MAX_AUTOFETCH_ITEMS = 400;
/** Itens por efeito de captura do banco VIVO. É o MESMO recorte do
 *  `MAGNET_CAPTURE_CHUNK` do Rust (`orchestrator/effects.rs`): o teto existe
 *  pelo tamanho do corpo (`express.json({limit:'1mb'})`), não pelo acervo. */
const MAX_CAPTURE_ITEMS = 200;

const IMDB_RE = /^tt\d+$/;

/** `season`/`episode` do payload: número, `null` ou ausente (o Rust manda `null`). */
function isNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number';
}

/** Colaboradores trocáveis em teste (mesmo padrão do internal-search.ts). */
export interface InternalSearchEffectsCollaborators {
  /** Enfileira candidato do Chupim (fila persistente; worker próprio drena). */
  enqueueAutofetch: typeof enqueueAutofetch;
  /** Alimenta o warmer do RD com as releases relevantes do lote. */
  queueRdWarmForRelevant: typeof queueRdWarmForRelevant;
  /** Enfileira candidatos BR em cache para interrogatório de áudio. */
  queueDubAudit: typeof queueDubAudit;
  /** Sonda dirigida BR (colheita com `brProbe: true`). */
  requestBrProbe: typeof requestBrProbe;
  /** Enfileira obra no colhedor NATIVO (`POST /harvest/enqueue` do gateway). */
  harvestEnqueue: (req: NativeHarvestEnqueue) => void;
  /** LRU de temporadas com pack pronto (Season Pack Fill). */
  registerSeasonSearchKey: typeof registerSeasonSearchKey;
  /** Lote pós-debrid do Chupim: reconstrói os streams e roda a cascata do Node. */
  runAutofetchBatch: typeof runAutofetchBatch;
  /** Banco VIVO: registra no `magnets.db` o que a coleta NATIVA viu. */
  captureItems: typeof captureItems;
}

/** Efeito conhecido: `kind` discriminado + payload já validado por tipo. */
type Effect = { kind: string; payload: Record<string, unknown> };

/**
 * Payload do efeito → pedido do colhedor NATIVO. O contrato do gateway não
 * aceita `null` em S/E (ausente = obra inteira) e recusa `type` fora de
 * `movie|series` — pedido sem tipo é descartado aqui, nunca convertido em
 * filme por omissão.
 */
function nativeHarvestRequest(
  p: Record<string, unknown>,
  reason: string,
): NativeHarvestEnqueue | null {
  const type = p.type === 'series' ? 'series' : p.type === 'movie' ? 'movie' : null;
  if (!type) return null;
  return {
    imdbId: String(p.imdbId),
    type,
    reason,
    ...(typeof p.season === 'number' ? { season: p.season } : {}),
    ...(typeof p.episode === 'number' ? { episode: p.episode } : {}),
  };
}

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
        case 'magnet_capture': {
          // Captura do banco VIVO. O recorte de 200 é do Rust e existe pelo
          // TAMANHO do corpo (`limit:'1mb'`): payload maior é rejeitado, nunca
          // truncado em silêncio.
          const items = payload.items;
          if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CAPTURE_ITEMS) return false;
          // `resetPassedFilter` só pode vir FALSE: reabrir o filtro da obra é
          // operação de outro caminho (`markFilterResult`), nunca da captura.
          if (payload.resetPassedFilter !== false) return false;
          if (typeof payload.indexer !== 'string') return false;
          if (payload.tracker !== undefined && typeof payload.tracker !== 'string') return false;
          if (typeof payload.imdbId !== 'string') return false;
          if (payload.imdbId !== '' && !IMDB_RE.test(payload.imdbId)) return false;
          if (!isNullableNumber(payload.season) || !isNullableNumber(payload.episode)) return false;
          if (payload.year !== undefined && payload.year !== null
            && typeof payload.year !== 'string' && typeof payload.year !== 'number') return false;
          // Forma grosseira do item: o sanitize de verdade (`inputFromItem`)
          // roda na drenagem do banco e recusa o que não tiver hash.
          return items.every((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
        }
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
      // o follow-up do índice (agora nativo, no Rust) manda a obra ao colhedor
      // (`br-gap`), preservando a rede de segurança. Sonda agendada já
      // enfileirou por dentro do `requestBrProbe` (com `brProbe: true`) — aqui
      // não duplica, e o fallback NÃO leva a flag: sonda inelegível não vira
      // sonda dirigida no gateway.
      if (result?.fallbackBrGap) {
        const req = nativeHarvestRequest(p, 'br-gap');
        if (req) deps.harvestEnqueue(req);
      }
      return;
    }
    case 'harvester_enqueue': {
      // `next-episode`/`miss`/`gap`/`br-gap` do Rust: o enfileiramento é do
      // gateway (fila, dedupe de 12h e prioridade são dele). A flag `brProbe`
      // só viaja quando o pedido veio como sonda dirigida — o Rust hoje não a
      // manda, mas o contrato do gateway a preserva.
      const req = nativeHarvestRequest(p, String(p.reason));
      if (req) deps.harvestEnqueue(p.brProbe === true ? { ...req, brProbe: true } : req);
      return;
    }
    case 'season_key':
      deps.registerSeasonSearchKey(
        String(p.adapter_id), String(p.account), String(p.imdb),
        Number(p.season), String(p.cache_key),
      );
      return;
    case 'magnet_capture': {
      // O grupo chega JÁ resolvido do Rust (`indexer || tracker`); o fallback
      // aqui é a segunda camada — o BLUDV publica `indexer: None` +
      // `tracker: "BLUDV"` e cair no balde `all` sumiria com a fonte.
      const group = String(p.indexer || p.tracker || '');
      // `resetPassedFilter: false` é FORÇADO (não lido do payload): a captura
      // registra o que a coleta VIU e nunca reabre o filtro da obra.
      const ctx: WorkCtx = {
        imdbId: String(p.imdbId || ''),
        season: typeof p.season === 'number' ? p.season : null,
        episode: typeof p.episode === 'number' ? p.episode : null,
        year: typeof p.year === 'string' || typeof p.year === 'number' ? p.year : null,
        resetPassedFilter: false,
      };
      const accepted = deps.captureItems(p.items as RawItem[], group, ctx);
      // Fila cheia = lote descartado: log e segue, o banco nunca segura a busca.
      if (!accepted) log.debug('[internal] magnet_capture: fila do banco vivo cheia');
      return;
    }
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
    enqueueAutofetch: overrides.enqueueAutofetch ?? enqueueAutofetch,
    queueRdWarmForRelevant: overrides.queueRdWarmForRelevant ?? queueRdWarmForRelevant,
    queueDubAudit: overrides.queueDubAudit ?? queueDubAudit,
    requestBrProbe: overrides.requestBrProbe ?? requestBrProbe,
    harvestEnqueue: overrides.harvestEnqueue ?? enqueueNativeHarvest,
    registerSeasonSearchKey: overrides.registerSeasonSearchKey ?? registerSeasonSearchKey,
    runAutofetchBatch: overrides.runAutofetchBatch ?? runAutofetchBatch,
    captureItems: overrides.captureItems ?? captureItems,
  };
  const json = express.json({ limit: '1mb' });

  router.post('/internal/search/effects', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleEffects(services, deps, req, res);
  }));
}
