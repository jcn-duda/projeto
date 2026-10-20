// Rota interna de LEITURA DO BANCO PARA A RESERVA 📦 (F1 fallback).
//
// O orquestrador Rust decide QUANDO consultar (`live.needsFallback()`), mas a
// leitura do SQLite (`worksForObraMany` + `sourcesForMany`) e o veredito de
// `allowedSourceIndexer` continuam aqui, onde o `opts()` do pedido existe. A
// seleção/cortes/tetos fica em `adom_core::fallback_bank`; esta rota só
// devolve as linhas da obra + a config efetiva que o núcleo consome.
//
// Sem config na URL: `encoded` no corpo + `runtime.run` (invariante 5). Guarda
// compartilhada: loopback + X-Indexer-Test-Token.
import { markKnownBroken } from './internal-search-evidence.js';
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import { worksForObraMany, sourcesForMany } from '../utils/magnet-bank-query.js';
import { obraTargets } from '../providers/magnet-bank-fallback.js';
import { allowedSourceIndexer } from '../providers/allowed-source-indexer.js';
import config from '../config.js';
import * as log from '../utils/logger.js';

const MAX_INDEXERS = 200;
const MAX_LIVE_HASHES = 2000;

/** Colaboradores trocáveis em teste (mesmo padrão das outras rotas internas). */
export interface InternalSearchFallbackCollaborators {
  worksForObraMany: typeof worksForObraMany;
  sourcesForMany: typeof sourcesForMany;
}

type ParsedSet = { ok: true; values: Set<string> } | { ok: false; error: string };

/** Array de strings → conjunto normalizado (o Node guarda indexer em minúsculo). */
function stringSet(value: unknown, name: string, max: number): ParsedSet {
  if (value === undefined) return { ok: true, values: new Set() };
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return { ok: false, error: `${name} deve ser array de strings` };
  }
  const values = new Set(
    (value as string[]).map((item) => item.trim().toLowerCase()).filter(Boolean),
  );
  if (values.size > max) return { ok: false, error: `${name} acima do teto de ${max}` };
  return { ok: true, values };
}

function limits() {
  const bank = config.magnetBank;
  const perIndexerMax = Math.max(1, Math.min(40, Math.trunc(bank?.fallbackMaxPerIndexer ?? 40) || 40));
  const globalMax = Math.max(1, Math.min(500, Math.trunc(bank?.fallbackGlobalMax ?? 40) || 40));
  return {
    enabled: Boolean(bank?.enabled),
    fallbackEnabled: Boolean(bank?.fallbackEnabled),
    perIndexerMax,
    globalMax,
  };
}

/**
 * POST /internal/search/fallback — `{ encoded, type, imdb, season?, episode?,
 * failed[], suspect[], all_failed, live_hashes[] }` →
 * `{ enabled, fallback_enabled, per_indexer_max, global_max, br_indexers,
 *    index_only_indexers, works[], sources{} }`.
 *
 * `failed` já é `failedIndexers()` (falhos + pendentes). O early return com
 * `works: []` espelha o `collectFallbackItems`: sem falha/suspeita ou com o
 * banco desligado, nada é lido.
 */
function handleFallback(
  services: AppServices,
  deps: InternalSearchFallbackCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as {
    type?: unknown; imdb?: unknown; season?: unknown; episode?: unknown;
    failed?: unknown; suspect?: unknown; all_failed?: unknown; live_hashes?: unknown;
  } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  const type = body?.type === 'series' ? 'series' : body?.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ ok: false, error: 'type deve ser movie ou series' });
  const imdbId = typeof body?.imdb === 'string' ? body.imdb.trim() : '';
  if (!/^tt\d+$/.test(imdbId)) {
    return res.status(400).json({ ok: false, error: 'imdb deve começar com tt<dígitos>' });
  }
  const season = typeof body?.season === 'number' && Number.isInteger(body.season) ? body.season : null;
  const episode = typeof body?.episode === 'number' && Number.isInteger(body.episode) ? body.episode : null;
  if (body?.all_failed !== undefined && typeof body.all_failed !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'all_failed deve ser boolean' });
  }
  const failed = stringSet(body?.failed, 'failed', MAX_INDEXERS);
  if (!failed.ok) return res.status(400).json({ ok: false, error: failed.error });
  const suspect = stringSet(body?.suspect, 'suspect', MAX_INDEXERS);
  if (!suspect.ok) return res.status(400).json({ ok: false, error: suspect.error });
  const liveHashes = stringSet(body?.live_hashes, 'live_hashes', MAX_LIVE_HASHES);
  if (!liveHashes.ok) return res.status(400).json({ ok: false, error: liveHashes.error });

  const { enabled, fallbackEnabled, perIndexerMax, globalMax } = limits();
  const brIndexers = config.jackett.ptBrIndexers || [];
  const indexOnlyIndexers = config.jackett.indexOnlyIndexers || [];
  const payload = (works: unknown[] = [], sources: Record<string, unknown> = {}) => ({
    ok: true,
    enabled,
    fallback_enabled: fallbackEnabled,
    per_indexer_max: perIndexerMax,
    global_max: globalMax,
    br_indexers: brIndexers,
    index_only_indexers: indexOnlyIndexers,
    works,
    sources,
  });

  const allFailed = body?.all_failed === true;
  if (!enabled || !fallbackEnabled) return res.json(payload());
  if (failed.values.size === 0 && !allFailed && suspect.values.size === 0) {
    return res.json(payload());
  }

  // Só obras com fonte num indexer FALHO/SUSPEITO entram na janela; com
  // `/all` falho, qualquer fonte do banco é candidata.
  const onlyIndexers = allFailed
    ? undefined
    : [...new Set([...failed.values, ...suspect.values])];
  const readLimit = Math.min(200, Math.max(globalMax, perIndexerMax) * 2);
  const maxTotal = globalMax * 3;

  try {
    const works = services.runtime.run({ opts: target.opts, encoded: target.encoded }, () => {
      const rows = deps.worksForObraMany(
        imdbId,
        obraTargets(type, season, episode),
        readLimit,
        maxTotal,
        onlyIndexers,
      );
      const hashes = [...new Set(
        rows
          .map((row) => String(row.magnet?.hash || '').toLowerCase())
          .filter(Boolean),
      )];
      const sources = deps.sourcesForMany(hashes);
      // Histórico ruim da conta (bad/lie/dead/miss): o Rust corta antes da checagem,
      // como o `pruneKnownBroken` do Node. Reserva também reapresentaria o hash.
      const probes: any[] = hashes.map((hash) => ({ infoHash: hash }));
      markKnownBroken(probes, { season, episode, imdbId });
      const brokenHashes = new Set(probes.filter((p) => p.broken).map((p) => p.infoHash));
      const workPayload = rows.map(({ work, magnet }) => ({
        hash: String(work.hash || ''),
        passed_filter: Number(work.passedFilter) || 0,
        last_seen: Number(work.lastSeen) || 0,
        magnet: magnet ? {
          hash: String(magnet.hash || ''),
          uri: String(magnet.uri || ''),
          title: String(magnet.title || ''),
          size: Number(magnet.size) || 0,
          is_br: Number(magnet.isBr) === 1,
          dubbed: Number(magnet.dubbed) === 1,
          quality: String(magnet.quality || ''),
          seeders_max: Number(magnet.seedersMax) || 0,
          seeders_last: Number(magnet.seedersLast) || 0,
          last_seen: Number(magnet.lastSeen) || 0,
          lied: Number(magnet.lied) === 1,
          broken: brokenHashes.has(String(magnet.hash || '').toLowerCase()),
        } : null,
      }));
      const sourcePayload = Object.fromEntries([...sources.entries()].map(([hash, list]) => [
        hash,
        list.map((source) => ({
          indexer: String(source.indexer || ''),
          tracker: String(source.tracker || ''),
          last_seen: Number(source.lastSeen) || 0,
          allowed: allowedSourceIndexer(source.indexer),
        })),
      ]));
      return { workPayload, sourcePayload };
    });
    log.debug(`[internal] fallback ${type} ${imdbId}: ${works.workPayload.length} obra(s)`);
    return res.json(payload(works.workPayload, works.sourcePayload));
  } catch (err) {
    log.error('[internal] fallback falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao ler a reserva' });
  }
}

export function registerInternalSearchFallback(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalSearchFallbackCollaborators> = {},
): void {
  const deps: InternalSearchFallbackCollaborators = {
    worksForObraMany: overrides.worksForObraMany ?? worksForObraMany,
    sourcesForMany: overrides.sourcesForMany ?? sourcesForMany,
  };
  const json = express.json({ limit: '256kb' });
  router.post('/internal/search/fallback', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleFallback(services, deps, req, res);
  }));
}
