import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import type express from 'express';
import { errorMessage } from '../utils/logger.js';

function makeResolveHandler(services: AppServices) {
  return asyncRoute(async (req: express.Request, res: express.Response) => {
    const infoHash = String(req.params.infoHash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) return res.status(400).send('infoHash inválido');

    const hint = typeof req.query.w === 'string' ? req.query.w : '';
    if (services.debrid.current()) {
      const ep = req.query.s != null && req.query.e != null ? `?s=${req.query.s}&e=${req.query.e}` : '';
      if (!services.verifyResolve(infoHash, ep, req.query.sig, hint)) {
        return res.status(403).send('assinatura inválida');
      }
    }

    let work: { names: string[]; year: number | null; pack: boolean } | null = null;
    let promisedDubbed = false;
    let hintedImdbId = '';
    if (hint) {
      try {
        const parsed = JSON.parse(hint);
        const names = Array.isArray(parsed?.n) ? parsed.n.map(String).slice(0, 4) : [];
        if (names.length) work = { names, year: Number(parsed.y) || null, pack: parsed.p === 1 };
        promisedDubbed = parsed?.d === 1;
        hintedImdbId = /^tt\d+$/.test(String(parsed?.i || '')) ? String(parsed.i) : '';
      } catch { /* dica ilegível: trata como ausente */ }
    }

    try {
      const adapter = services.debrid.current();
      const link = await services.debrid.resolveLink(infoHash, {
        season: req.query.s ? Number(req.query.s) : null,
        episode: req.query.e ? Number(req.query.e) : null,
        work,
        dubbed: promisedDubbed,
      });
      if (!link) {
        services.log.warn('[resolve] torrent ' + infoHash.slice(0, 8) + ' ainda baixando no debrid');
        return res.status(404).send('o torrent ainda está baixando no debrid');
      }
      if (adapter) services.magnetdb.markAlive(adapter.id, services.runtime.opts().debridApiKey, [infoHash]);
      return res.redirect(302, link);
    } catch (err: any) {
      if (services.debridCommon.isNoVideoError(err)) {
        const adapter = services.debrid.current();
        if (adapter) services.magnetdb.markBad(adapter.id, services.runtime.opts().debridApiKey, infoHash);
        return res.status(404).send('nenhum arquivo de vídeo no torrent');
      }
      // 429 nao e culpa do torrent: o debrid pediu para esperar. Sem isto virava
      // "falha ao resolver" generico, que manda o usuario trocar de fonte a esmo
      // quando trocar nao adianta — e cada tentativa nova so piora o limite.
      if (services.debridCommon.isRateLimitError(err)) {
        services.log.warn('[resolve] ' + infoHash.slice(0, 8) + ': debrid pediu para desacelerar (429)');
        return res.status(429).send('o debrid está limitando as requisições; espere um pouco e tente de novo');
      }
      // 451 é uma recusa legal do serviço, não evidência de torrent sem vídeo.
      // Só NoVideoError pode alimentar o magnetdb; bloquear este hash ali
      // esconderia uma fonte potencialmente tocável em outro debrid.
      if (services.debridCommon.isBlockedError(err)) {
        services.log.warn('[resolve] torrent ' + infoHash.slice(0, 8) + ' bloqueado pelo debrid (451)');
        return res.status(451).send('o debrid bloqueou este conteúdo por motivo legal');
      }
      if (services.debridCommon.isDubLieError(err)) {
        const adapter = services.debrid.current();
        if (adapter) services.magnetdb.markLie(adapter.id, services.runtime.opts().debridApiKey, infoHash);
        if (hintedImdbId) {
          services.releaseIndex.markLied(hintedImdbId, {
            season: req.query.s ? Number(req.query.s) : null,
            episode: req.query.e ? Number(req.query.e) : null,
          }, infoHash);
        }
        services.metrics.count('debrid.audit.lie');
        services.log.warn(
          `[resolve] torrent ${infoHash.slice(0, 8)} anunciado como dublado provou release EN` +
          `${err.evidence?.matchedGroup ? ` (${err.evidence.matchedGroup})` : ''}`,
        );
        return res.status(404).send('o torrent anunciado como dublado contém conteúdo em inglês');
      }
      if (services.debridCommon.isWorkPickError(err)) {
        services.log.warn(`[resolve] torrent ${infoHash.slice(0, 8)} não identificou a obra dentro do pack`);
        return res.status(404).send('não foi possível identificar este filme dentro do pack');
      }
      if (services.debridCommon.isEpisodePickError(err)) {
        services.log.warn(
          `[resolve] torrent ${infoHash.slice(0, 8)} não contém o episódio pedido` +
          `${req.query.s != null && req.query.e != null ? ` (S${req.query.s}E${req.query.e})` : ''}` +
          `${err.evidence ? ` — arquivo declara S${err.evidence.declaredSeasons.join(',') || '?'}E${err.evidence.declaredEpisodes.join(',') || '?'}${err.evidence.sample ? ` (${err.evidence.sample})` : ''}` : ''}` +
          `${!err.evidence && err.context ? ` — ${err.context.videoCount} vídeo(s), nenhum identificável: ${err.context.samples.join(' | ')}` : ''}`,
        );
        const sNum = Number(req.query.s);
        const eNum = Number(req.query.e);
        if (err.evidence && hintedImdbId && Number.isFinite(sNum) && Number.isFinite(eNum)) {
          services.releaseIndex.markMissing(hintedImdbId, { season: sNum, episode: eNum }, infoHash);
        }
        return res.status(404).send('este episódio não foi encontrado no pack');
      }
      services.log.error('[resolve]', errorMessage(err));
      return res.status(502).send('falha ao resolver no debrid');
    }
  });
}

export { makeResolveHandler };
