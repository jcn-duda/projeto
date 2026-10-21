// Rotas internas de BUSCA (fatia F1.1) — POST /internal/search/meta. São as
// leituras que o orquestrador Rust (`rust/crates/adom-search`) consome como
// fallback do caminho nativo: metadados (Cinemeta+TMDB).
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
import { startMultiWorkDiscovery, startHomeReleaseLookup } from '../providers/tmdb-multiwork.js';
import { collectRaw } from '../providers/collect-orchestrator.js';
import { handleCollect } from './internal-search-collect.js';
import { breakerSnapshot } from '../providers/jackett-breaker.js';
import { parseStremioId } from '../utils/format.js';
import * as log from '../utils/logger.js';
// Guarda/prazo compartilhados e as rotas de escrita/efeitos vivem nos irmãos
// (extraídos pela catraca de linhas); este arquivo continua o ponto de montagem.
import { rejectedByGuard, decodeTarget, withinDeadline, DEADLINE } from './internal-search-shared.js';
import { registerInternalSearchEffects } from './internal-search-effects.js';
import type { InternalSearchEffectsCollaborators } from './internal-search-effects.js';

export { isLoopbackAddress } from './internal-search-shared.js';

// Guarda compartilhada: ver irmãos (extraídos pela catraca de linhas).

/** Colaboradores trocáveis em teste (mesmo padrão de internal-crawl-result). */
export interface InternalSearchCollaborators {
  getMeta: typeof getMeta;
  getTitles: typeof getTitles;
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
    collectRaw: overrides.collectRaw ?? collectRaw,
    breakerSnapshot: overrides.breakerSnapshot ?? breakerSnapshot,
  };
  const json = express.json({ limit: '256kb' });

  router.post('/internal/search/meta', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleMeta(services, deps, req, res);
  }));

  router.post('/internal/search/collect', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleCollect(services, deps, req, res);
  }));

  // Escrita e efeitos do orquestrador (index-write/effects) — mesmo guarda,
  // mesma posição no roteador (antes do overlay /:userConfig).
  registerInternalSearchEffects(router, services, effectsOverrides);
}
