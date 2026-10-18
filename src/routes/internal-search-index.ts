// Rota interna de LEITURA DO ÍNDICE E BANCO INSTANTÂNEO (Fase F1 / Etapa 2):
// POST /internal/search/index — lookup do releaseIndex e collectInstantItems
// em lote para o orquestrador nativo Rust responder em ~0,8s quando o acervo
// cobre a obra.
//
// Sem config na URL: o usuário vem no CORPO (`encoded`), decodificado aqui e
// executado dentro de `runtime.run` (invariante 5: a preferência nunca vem do .env).
// Guarda compartilhada: loopback + X-Indexer-Test-Token.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import * as releaseIndex from '../utils/release-index.js';
import { idxPoolCovered, idxReleasesToRaw } from '../providers/search-pool-coverage.js';
import { collectInstantItems } from '../providers/magnet-bank-instant.js';
import { allowedSourceIndexer } from '../providers/allowed-source-indexer.js';
import * as account from '../providers/account.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { enqueueIndexFollowUp } from '../providers/search-index-path.js';
import config from '../config.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';

const IMDB_RE = /^tt\d+$/;

export function registerInternalSearchIndex(router: Router, services: AppServices): void {
  const json = express.json({ limit: '64kb' });

  router.post('/internal/search/index', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;

    const body = req.body as {
      encoded?: unknown;
      type?: unknown;
      imdb?: unknown;
      season?: unknown;
      episode?: unknown;
      names?: unknown;
      year?: unknown;
      released?: unknown;
      first_aired?: unknown;
    } | undefined;

    const target = decodeTarget(services, body);
    if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

    const imdbId = typeof body?.imdb === 'string' ? body.imdb.trim() : '';
    if (!IMDB_RE.test(imdbId)) {
      return res.status(400).json({ ok: false, error: 'imdb deve começar com tt<dígitos>' });
    }
    const type = body?.type === 'series' ? 'series' : body?.type === 'movie' ? 'movie' : null;
    if (!type) return res.status(400).json({ ok: false, error: 'type deve ser movie ou series' });

    const season = typeof body?.season === 'number' && Number.isInteger(body.season) ? body.season : null;
    const episode = typeof body?.episode === 'number' && Number.isInteger(body.episode) ? body.episode : null;
    const year = (typeof body?.year === 'number' || typeof body?.year === 'string') ? body.year : null;
    const released = typeof body?.released === 'string' && body.released.trim() ? body.released.trim() : null;
    const firstAired = typeof body?.first_aired === 'string' && body.first_aired.trim() ? body.first_aired.trim() : null;
    const names = Array.isArray(body?.names) && body.names.every((n) => typeof n === 'string')
      ? (body.names as string[]).filter((n) => n.trim())
      : [];

    await services.runtime.run({ opts: target.opts, encoded: target.encoded }, async () => {
      try {
        const indexed = (config.releaseIndex.enabled ? releaseIndex.lookup(imdbId, { season, episode }) : [])
          .filter((r) => r?.source === 'autofetch' || allowedSourceIndexer(String(r.indexer || '')));
        const isPartial = indexed.length > 0 && config.releaseIndex.enabled && releaseIndex.isPartial(imdbId, { season, episode });
        const covered = indexed.length > 0 && !isPartial && idxPoolCovered(indexed, { season, episode, countMetrics: false });
        const autofetchSeeded = indexed.some((r) => r.source === 'autofetch');
        const indexCovered = !isPartial && (covered || autofetchSeeded);

        const instantResult = collectInstantItems({
          type,
          imdbId,
          season,
          episode,
          meta: { year, released, firstAired },
          preferDubbed: opts().preferDubbed,
          indexReleases: indexed,
          names,
          isSeries: season != null,
          year,
        });

        if (instantResult.eligible && config.releaseIndex.enabled) {
          enqueueIndexFollowUp({
            indexed,
            partial: isPartial,
            covered,
            type,
            imdbId,
            season,
            episode,
            countMetrics: false,
          });
        } else if (config.releaseIndex.enabled) {
          enqueueIndexFollowUp({
            indexed,
            partial: isPartial,
            covered,
            type,
            imdbId,
            season,
            episode,
            countMetrics: true,
          });
        }

        let accountItems: any[] = [];
        const accountSource = config.debrid.inventorySource && Boolean(services.debrid?.current?.());
        if (config.accountFastPath.enabled && accountSource) {
          const matchContext = {
            names: names.length > 0 ? names : [imdbId],
            year,
            isSeries: season != null,
            season,
            episode,
            released: null,
            firstAired: null,
          };
          accountItems = await raceWithDeadline(
            account.search(matchContext, null),
            config.accountFastPath.waitMs,
            () => [] as any[],
          );
        }

        return res.json({
          ok: true,
          is_partial: isPartial,
          index_covered: indexCovered,
          instant_eligible: instantResult.eligible,
          index_items: idxReleasesToRaw(indexed).map((item) => ({ ...item, fromSnapshot: true })),
          instant_items: instantResult.items,
          account_items: accountItems,
        });
      } catch (err) {
        log.error('[internal-search-index] falha ao consultar índice/banco:', err);
        return res.status(500).json({ ok: false, error: 'falha interna ao consultar índice' });
      }
    });
  }));
}
