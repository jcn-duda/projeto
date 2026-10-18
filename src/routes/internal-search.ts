// Rotas internas de BUSCA (fatia F1.1) — POST /internal/search/meta e
// POST /internal/search/state. São as leituras que o orquestrador Rust
// (`rust/crates/adom-search`, embrião) vai consumir antes de assumir o /stream:
// metadados (Cinemeta+TMDB) e o acervo em lote (banco de magnets + índice).
//
// SEM config na URL: montada ANTES de /:userConfig em register.ts, junto das
// rotas do sidecar (`internal-crawl-result`/`internal-activity`). O usuário vem
// no CORPO (`encoded`), decodificado aqui e executado dentro de `runtime.run` —
// invariante 5: a preferência do usuário nunca vem do `.env`.
//
// Guarda compartilhada: só loopback (o sidecar/orquestrador fala pela mesma
// máquina) + `X-Indexer-Test-Token` (mesmo token do painel). Observação de
// borda: se um proxy NA FRENTE do addon encaminhar `/internal/*`, o socket
// local continua 127.0.0.1 e a guarda de loopback não vê o cliente real — quem
// barra nesse cenário é o token. O gateway Rust (`GATEWAY=on`) recusa
// `/internal/*` antes do proxy; o Caddy também bloqueia. Ainda assim, não
// exponha `/internal/` em proxy de terceiro.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import type { MatchContext } from '../../types/domain.js';
import { getMeta } from '../utils/cinemeta.js';
import { getTitles } from '../utils/tmdb.js';
import { worksForObraMany, sourcesForMany, firstSeenMany } from '../utils/magnet-bank-query.js';
import { startMultiWorkDiscovery, startHomeReleaseLookup } from '../providers/search-multiwork.js';
import { collectRaw } from '../providers/collect-orchestrator.js';
import { breakerSnapshot } from '../providers/jackett-breaker.js';
import { parseStremioId } from '../utils/format.js';
import { raceWithDeadline } from '../utils/deadline.js';
import * as log from '../utils/logger.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Tetos de entrada: a rota recebe LISTAS (obras/hashes), não mídia. Sem teto,
// um chamador (ou bug) transformaria a leitura em varredura do acervo inteiro.
const MAX_OBRA_KEYS = 200;
const MAX_HASHES = 2000;
const WORKS_PER_TARGET = 50;
const MAX_WORKS_TOTAL = 500;

// `tt1234567` (filme) ou `tt1234567:<temporada>:<episódio>` (série) — o mesmo
// id que o `/stream` monta, sem o `.json`. Formato inválido é 400: adivinhar a
// obra esconderia erro de integração do lado Rust.
const OBRA_KEY_RE = /^(tt\d+)(?::(\d{1,4}):(\d{1,4}))?$/;

const DEADLINE = Symbol('internal-search-deadline');

/** Chamadas internas fora do loopback são recusadas (defesa em profundidade). */
export function isLoopbackAddress(address: string | null | undefined) {
  return Boolean(address) && LOOPBACK_ADDRESSES.has(String(address));
}

/**
 * Guarda das rotas internas. Devolve `true` quando a resposta já foi escrita —
 * o handler sai na hora. Ordem: 403 (origem), 503 (operador sem token), 401
 * (token errado); o token é o que classifica o cliente, por isso vem depois.
 */
function rejectedByGuard(services: AppServices, req: express.Request, res: express.Response) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    res.status(403).json({ ok: false, error: 'rota interna disponível apenas em loopback' });
    return true;
  }
  if (!services.config.jackett.testToken) {
    res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
    return true;
  }
  if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    return true;
  }
  return false;
}

type DecodedUserConfig = NonNullable<ReturnType<AppServices['runtime']['decode']>>;

/** Decodifica o `encoded` do corpo; `null` = config inválida (400 no handler). */
function decodeTarget(services: AppServices, body: unknown) {
  const encoded = typeof (body as { encoded?: unknown })?.encoded === 'string'
    ? String((body as { encoded: string }).encoded)
    : '';
  if (!encoded) return null;
  const opts = services.runtime.decode(encoded);
  return opts ? { opts, encoded } : null;
}

/** Corre a tarefa contra o prazo do cliente; `DEADLINE` = estourou (504). */
async function withinDeadline<T>(task: Promise<T>, budgetMs: number): Promise<T | typeof DEADLINE> {
  return raceWithDeadline(task, Math.max(1, budgetMs), () => DEADLINE);
}

/** Colaboradores trocáveis em teste (mesmo padrão de internal-crawl-result). */
export interface InternalSearchCollaborators {
  getMeta: typeof getMeta;
  getTitles: typeof getTitles;
  worksForObraMany: typeof worksForObraMany;
  sourcesForMany: typeof sourcesForMany;
  firstSeenMany: typeof firstSeenMany;
  /** Coleta por taskScope (mesma assinatura do `collectRaw`); trocável em teste. */
  collectRaw: typeof collectRaw;
  /** Foto do circuit breaker por indexer; trocável em teste. */
  breakerSnapshot: typeof breakerSnapshot;
}

/**
 * POST /internal/search/meta — `{ encoded, type, id }` → `{ meta, titles }`.
 *
 * `type`/`id` são os do protocolo Stremio (`tt…` ou `tt…:s:e`); o IMDb id sai
 * do `parseStremioId`. Os opcionais `include_multiwork`/`include_home_release`
 * acrescentam o contexto que o `doSearch` também carrega (coleção TMDB e 1º
 * lançamento doméstico), ao custo de uma ida extra ao TMDB cada — por isso são
 * opt-in, não default.
 */
async function handleMeta(
  services: AppServices,
  deps: InternalSearchCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { type?: unknown; id?: unknown; include_multiwork?: unknown; include_home_release?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  const type = body?.type === 'series' ? 'series' : body?.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ ok: false, error: 'type deve ser movie ou series' });
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  const { imdbId, season, episode } = parseStremioId(id);
  if (!/^tt\d+$/.test(imdbId)) return res.status(400).json({ ok: false, error: 'id deve começar com tt<dígitos>' });

  const wantsMultiWork = body?.include_multiwork === true;
  const wantsHomeRelease = body?.include_home_release === true;
  const budget = services.runtime.clientReplyDeadline(req.get('user-agent')) || services.config.replyDeadline;
  const deadlineAt = Date.now() + budget;
  const ctx = { opts: target.opts, encoded: target.encoded, replyDeadlineMs: budget };

  try {
    const value = await services.runtime.run(ctx, () => withinDeadline((async () => {
      // Cinemeta e TMDB são fontes distintas e falham de forma independente: a
      // rota espelha o doSearch (mesmo `Promise.all`), e o Rust decide o que
      // fazer com `null` em cada lado.
      const [meta, titles] = await Promise.all([deps.getMeta(type, imdbId), deps.getTitles(imdbId)]);
      const isDemo = target.opts.providers.includes('demo');
      const [multiWork, homeReleaseAt] = await Promise.all([
        wantsMultiWork ? startMultiWorkDiscovery({ imdbId, season, isDemo, deadlineAt }) : Promise.resolve(null),
        wantsHomeRelease ? startHomeReleaseLookup({ imdbId, season, isDemo, deadlineAt }) : Promise.resolve(null),
      ]);
      return { meta, titles, multiWork, homeReleaseAt };
    })(), budget));

    if (value === DEADLINE) {
      log.warn(`[internal-search] meta ${type} ${id}: prazo de ${budget}ms atingido`);
      return res.status(504).json({ ok: false, error: 'prazo interno esgotado' });
    }
    log.debug(`[internal-search] meta ${type} ${id}: meta=${value.meta ? 'ok' : 'null'} titles=${value.titles ? 'ok' : 'null'}`);
    return res.json({
      ok: true,
      type,
      id,
      imdb_id: imdbId,
      season,
      episode,
      meta: value.meta,
      titles: value.titles,
      ...(wantsMultiWork ? { multiWork: value.multiWork } : {}),
      ...(wantsHomeRelease ? { homeReleaseAt: value.homeReleaseAt } : {}),
    });
  } catch (err) {
    // Erro de função interna não derruba o processo: 500 curto e o log fica com
    // o detalhe. Nada de caminho absoluto nem segredo na resposta.
    log.error('[internal-search] falha ao ler metadados:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao ler metadados' });
  }
}

type ObraKey = { imdb: string; season: number | null; episode: number | null };

function parseObraKey(key: string): ObraKey | null {
  const match = OBRA_KEY_RE.exec(key);
  if (!match) return null;
  return {
    imdb: match[1],
    season: match[2] != null ? Number(match[2]) : null,
    episode: match[3] != null ? Number(match[3]) : null,
  };
}

/** Chave normalizada de balde — `-1` é o nulo da PK de `magnet_work`. */
function bucketOf(imdb: string, season: number | null, episode: number | null) {
  return `${imdb}:${season ?? -1}:${episode ?? -1}`;
}

/**
 * POST /internal/search/state — leitura em LOTE do acervo:
 * `{ encoded, obra_keys: [...], hashes: [...] }` →
 * `{ obras: {...}, sources: {...}, firstSeen: {...} }`.
 *
 * Devolve só o que as consultas em lote dão (`worksForObraMany`,
 * `sourcesForMany`, `firstSeenMany`), sem inventar cache: hash/obra sem linha
 * simplesmente não aparece no objeto. `obra_keys` cobre filme (`tt…`) e
 * episódio (`tt…:s:e`); a mesma obra repetida é deduplicada e cada chave de
 * resposta é EXATAMENTE a chave pedida.
 */
function handleState(services: AppServices, deps: InternalSearchCollaborators, req: express.Request, res: express.Response) {
  const body = req.body as { obra_keys?: unknown; hashes?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  const rawKeys = body?.obra_keys === undefined ? [] : body.obra_keys;
  const rawHashes = body?.hashes === undefined ? [] : body.hashes;
  if (!Array.isArray(rawKeys) || !rawKeys.every((k) => typeof k === 'string')) {
    return res.status(400).json({ ok: false, error: 'obra_keys deve ser array de strings' });
  }
  if (!Array.isArray(rawHashes) || !rawHashes.every((h) => typeof h === 'string')) {
    return res.status(400).json({ ok: false, error: 'hashes deve ser array de strings' });
  }
  if (rawKeys.length > MAX_OBRA_KEYS) {
    return res.status(400).json({ ok: false, error: `obra_keys acima do teto de ${MAX_OBRA_KEYS}` });
  }
  if (rawHashes.length > MAX_HASHES) {
    return res.status(400).json({ ok: false, error: `hashes acima do teto de ${MAX_HASHES}` });
  }

  const maxTotal = Math.min(MAX_WORKS_TOTAL, Math.max(WORKS_PER_TARGET, rawKeys.length * WORKS_PER_TARGET));
  const buckets = new Map<string, { key: string; obra: ObraKey }>();
  const groups = new Map<string, { imdb: string; targets: Array<{ season: number | null; episode: number | null }> }>();
  for (const key of rawKeys) {
    const obra = parseObraKey(key);
    if (!obra) return res.status(400).json({ ok: false, error: `obra_key inválida: ${key}` });
    const bucket = bucketOf(obra.imdb, obra.season, obra.episode);
    if (buckets.has(bucket)) continue;
    buckets.set(bucket, { key, obra });
    const group = groups.get(obra.imdb) ?? { imdb: obra.imdb, targets: [] };
    group.targets.push({ season: obra.season, episode: obra.episode });
    groups.set(obra.imdb, group);
  }

  const hashes = [...new Set(rawHashes.map((h) => h.trim().toLowerCase()).filter(Boolean))];

  try {
    // Uma leitura por OBRA (não por episódio) alimenta todos os alvos dela; as
    // linhas voltam com o par season/episode para o balde certo.
    const obras: Record<string, unknown[]> = Object.fromEntries([...buckets.values()].map(({ key }) => [key, []]));
    for (const group of groups.values()) {
      const rows = deps.worksForObraMany(group.imdb, group.targets, WORKS_PER_TARGET, maxTotal);
      for (const row of rows) {
        const bucket = bucketOf(row.work.imdb, row.work.season, row.work.episode);
        const entry = buckets.get(bucket);
        if (entry) obras[entry.key].push(row);
      }
    }

    // `Map` → objeto na ordem de `firstSeen` da entrada; hash sem linha fica de
    // fora (é o contrato de "só o que as funções dão").
    const sources = Object.fromEntries([...deps.sourcesForMany(hashes)].sort(([a], [b]) => a.localeCompare(b)));
    const firstSeen = Object.fromEntries([...deps.firstSeenMany(hashes)].sort(([a], [b]) => a.localeCompare(b)));

    log.debug(`[internal-search] state: obras=${rawKeys.length} hashes=${hashes.length} sources=${Object.keys(sources).length}`);
    return res.json({ ok: true, obras, sources, firstSeen });
  } catch (err) {
    log.error('[internal-search] falha ao ler o acervo:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao ler o acervo' });
  }
}

/**
 * POST /internal/search/collect — UM `taskScope` do `collectRaw` com prazo
 * ABSOLUTO. É o passo que o orquestrador Rust pede ao Node enquanto a rede não
 * migrou: o corpo traz a obra (query/pt/imdb/S/E/ano), o `encoded` do usuário e
 * o instante em que a resposta precisa ter saído (`deadline_at`, epoch ms).
 *
 * Contrato de resposta: itens crus por indexer (mesma forma do cache `raw:v1` —
 * array de `RawItem` por indexer), o `LiveIndexerState` em snapshot e o estado
 * do circuit breaker dos indexers envolvidos. Falha de task nunca rejeita: o
 * `collectRaw` já roda tudo em `allSettled` (→ `[]`); o `raceWithDeadline` daqui
 * é a rede de segurança para o caso patológico de promessa que nunca assenta —
 * "nunca lançar depois do prazo" vira 504, não erro de processo.
 */
async function handleCollect(
  services: AppServices,
  deps: InternalSearchCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as {
    task_scope?: unknown; query?: unknown; pt_query?: unknown; type?: unknown; imdb?: unknown;
    season?: unknown; episode?: unknown; year?: unknown; names?: unknown;
    sweep_query?: unknown; original_query?: unknown; multi_work_query?: unknown; deadline_at?: unknown;
  } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  // task_scope é o SELETOR do collectRaw; valor presente e inválido é 400 —
  // adivinhar escopo esconderia erro de integração do lado Rust.
  const scope = body?.task_scope === undefined ? 'all' : body.task_scope;
  if (scope !== 'all' && scope !== 'priority' && scope !== 'nonpriority') {
    return res.status(400).json({ ok: false, error: 'task_scope deve ser all, priority ou nonpriority' });
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (!query) return res.status(400).json({ ok: false, error: 'query é obrigatória' });
  const type = body?.type === 'series' ? 'series' : body?.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ ok: false, error: 'type deve ser movie ou series' });
  const imdbId = typeof body?.imdb === 'string' ? body.imdb.trim() : '';
  if (!/^tt\d+$/.test(imdbId)) return res.status(400).json({ ok: false, error: 'imdb deve começar com tt<dígitos>' });
  const season = typeof body?.season === 'number' && Number.isInteger(body.season) ? body.season : null;
  const episode = typeof body?.episode === 'number' && Number.isInteger(body.episode) ? body.episode : null;
  const year = (typeof body?.year === 'number' || typeof body?.year === 'string') ? body.year : null;
  // Prazo ABSOLUTO (epoch ms): quem decide o orçamento é o orquestrador, que
  // provavelmente herdou o prazo do cliente. Já vencido é bug do chamador (400).
  const deadlineAt = typeof body?.deadline_at === 'number' && Number.isFinite(body.deadline_at) ? body.deadline_at : NaN;
  if (!Number.isFinite(deadlineAt)) return res.status(400).json({ ok: false, error: 'deadline_at (epoch ms) é obrigatório' });
  const budget = deadlineAt - Date.now();
  if (budget <= 0) return res.status(400).json({ ok: false, error: 'deadline_at já venceu' });
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const ptQuery = str(body?.pt_query);
  const sweepQuery = str(body?.sweep_query);
  const originalQuery = str(body?.original_query);
  const multiWorkQuery = str(body?.multi_work_query);
  const names = Array.isArray(body?.names) && body.names.every((n: unknown) => typeof n === 'string')
    ? (body.names as string[]).filter((n) => n.trim())
    : null;
  if (body?.names !== undefined && !names) {
    return res.status(400).json({ ok: false, error: 'names deve ser array de strings' });
  }
  // Mesmo `MatchContext` que o doSearch monta; sem metadados aqui, `names` cai
  // para a própria query (o orquestrador Rust manda os nomes que já tem).
  const matchContext: MatchContext = {
    names: names && names.length > 0 ? names : [query],
    year,
    isSeries: season != null,
    season,
    episode,
    released: null,
    firstAired: null,
  };
  const ctx = { opts: target.opts, encoded: target.encoded, replyDeadlineMs: budget };

  try {
    const value = await services.runtime.run(ctx, () =>
      withinDeadline(deps.collectRaw(
        query, type, imdbId, ptQuery, matchContext,
        null, sweepQuery, deadlineAt, scope,
        // Sem observador nem trace: a rota é o OLHO do orquestrador, não um
        // /stream — nada aqui estagia timing nem escreve índice.
        null, null, originalQuery, multiWorkQuery,
      ), budget));

    if (value === DEADLINE) {
      log.warn(`[internal] collect ${type} ${imdbId}: prazo de ${Math.round(budget)}ms atingido`);
      return res.status(504).json({ ok: false, error: 'prazo interno esgotado' });
    }
    // Itens crus agrupados por indexer — mesma unidade do cache `raw:v1`
    // (array de RawItem por fonte). Fonte sem rótulo vira "sem-indexer": o
    // orquestrador decide o que fazer, a rota não descarta item.
    const byIndexer: Record<string, any[]> = {};
    for (const item of value.items) {
      const key = String(item?.indexer || item?.Indexer || item?.tracker || '').trim() || 'sem-indexer';
      (byIndexer[key] ||= []).push(item);
    }
    // O breaker é foto POR indexer: cobre quem apareceu no lote e quem o estado
    // vivo marcou (falho/pendente/vazio) — é o conjunto que o Rust precisa para
    // decidir fallback sem uma segunda viagem.
    const breakerIds = new Set<string>(Object.keys(byIndexer));
    if (value.live) {
      for (const id of value.live.failed.keys()) breakerIds.add(id);
      for (const id of value.live.pending) breakerIds.add(id);
      for (const id of value.live.empty) breakerIds.add(id);
      for (const id of value.live.served) breakerIds.add(id);
    }
    const breaker = Object.fromEntries([...breakerIds].sort().map((id) => [id, deps.breakerSnapshot(id)]));
    log.debug(`[internal] collect ${type} ${imdbId} [${scope}]: ${value.items.length} item(ns), partial=${value.partial}`);
    return res.json({
      ok: true,
      task_scope: scope,
      query,
      imdb_id: imdbId,
      season,
      episode,
      partial: value.partial,
      items: value.items,
      by_indexer: byIndexer,
      live: value.live ? value.live.snapshot() : null,
      breaker,
    });
  } catch (err) {
    // Erro inesperado (bug, não rede — rede vira `[]` dentro do collectRaw):
    // 500 curto e o log fica com o detalhe.
    log.error('[internal] collect falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao coletar' });
  }
}

/**
 * Registra as rotas internas de busca no router fornecido. O maestro
 * (`register.ts`) monta ANTES do overlay `/:userConfig`.
 */
export function registerInternalSearch(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalSearchCollaborators> = {},
): void {
  const deps: InternalSearchCollaborators = {
    getMeta: overrides.getMeta ?? getMeta,
    getTitles: overrides.getTitles ?? getTitles,
    worksForObraMany: overrides.worksForObraMany ?? worksForObraMany,
    sourcesForMany: overrides.sourcesForMany ?? sourcesForMany,
    firstSeenMany: overrides.firstSeenMany ?? firstSeenMany,
    collectRaw: overrides.collectRaw ?? collectRaw,
    breakerSnapshot: overrides.breakerSnapshot ?? breakerSnapshot,
  };
  const json = express.json({ limit: '256kb' });

  router.post('/internal/search/meta', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleMeta(services, deps, req, res);
  }));

  router.post('/internal/search/state', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleState(services, deps, req, res);
  }));

  router.post('/internal/search/collect', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleCollect(services, deps, req, res);
  }));
}
