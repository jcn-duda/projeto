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
import { getMeta } from '../utils/cinemeta.js';
import { getTitles } from '../utils/tmdb.js';
import { worksForObraMany, sourcesForMany, firstSeenMany } from '../utils/magnet-bank-query.js';
import { startMultiWorkDiscovery, startHomeReleaseLookup } from '../providers/search-multiwork.js';
import { collectRaw } from '../providers/collect-orchestrator.js';
import { handleCollect } from './internal-search-collect.js';
import { handleConfig } from './internal-search-config.js';
import { breakerSnapshot } from '../providers/jackett-breaker.js';
import { parseStremioId } from '../utils/format.js';
import * as log from '../utils/logger.js';
// Guarda/prazo compartilhados e as rotas de escrita/efeitos vivem nos irmãos
// (extraídos pela catraca de linhas); este arquivo continua o ponto de montagem.
import { rejectedByGuard, decodeTarget, withinDeadline, DEADLINE } from './internal-search-shared.js';
import { registerInternalSearchEffects } from './internal-search-effects.js';
import type { InternalSearchEffectsCollaborators } from './internal-search-effects.js';

export { isLoopbackAddress } from './internal-search-shared.js';

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
 * Registra as rotas internas de busca no router fornecido. O maestro
 * (`register.ts`) monta ANTES do overlay `/:userConfig`.
 */
export function registerInternalSearch(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalSearchCollaborators> = {},
  effectsOverrides: Partial<InternalSearchEffectsCollaborators> = {},
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

  // Knobs do operador + opções decodificadas, sem credencial. Usado pelo gate
  // congelado (docs/stream-frozen-gate.md) para o Rust replays com os MESMOS
  // números da captura.
  router.post('/internal/search/config', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleConfig(services, req, res);
  }));

  // Escrita e efeitos do orquestrador (index-write/effects) — mesmo guarda,
  // mesma posição no roteador (antes do overlay /:userConfig).
  registerInternalSearchEffects(router, services, effectsOverrides);
}
