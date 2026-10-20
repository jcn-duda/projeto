// POST /internal/search/config — números do operador + opções decodificadas.
//
// Existe para o gate de paridade congelada (`docs/stream-frozen-gate.md`): o
// orquestrador Rust precisa dos MESMOS knobs que o Node usou na captura
// (cotas, piso de seeders, prazos, estilo de nome). Nada de credencial: a chave
// de debrid vira booleano e o segredo do HMAC não sai daqui.
import express from 'express';
import type { AppServices } from './types.js';
import config from '../config.js';
import { decodeTarget } from './internal-search-shared.js';

/** `opts()` sem os campos secretos. */
function sanitizedOptions(opts: Record<string, any>) {
  const { debridApiKey, ...rest } = opts;
  return { ...rest, hasDebridKey: Boolean(debridApiKey) };
}

export function handleConfig(services: AppServices, req: express.Request, res: express.Response) {
  const target = decodeTarget(services, req.body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });
  const opts = sanitizedOptions(target.opts as Record<string, any>);
  res.json({
    ok: true,
    format: 'adom-search-config/1',
    options: opts,
    operator: {
      replyDeadline: config.replyDeadline,
      appReplyDeadline: config.appReplyDeadline,
      cacheTtl: config.cacheTtl,
      fallbackStreamsTtl: config.fallbackStreamsTtl,
      streamStaleGrace: config.streamStaleGrace,
      resolveUncached: config.debrid.resolveUncached,
      debrid: {
        service: config.debrid.service,
        cachedOnly: config.debrid.cachedOnly,
        showUncachedBr: config.debrid.showUncachedBr,
        allowEnvKey: config.debrid.allowEnvKey,
      },
      search: {
        maxPerIndexer: config.maxPerIndexer,
        candidatePoolFactor: config.candidatePoolFactor,
        brReservedPerQuality: config.brReservedPerQuality,
        unairedMarginMs: config.search.unairedMarginMs,
        preAirReleaseMarginMs: config.search.preAirReleaseMarginMs,
        preHomeReleaseCut: config.search.preHomeReleaseCut,
        preHomeReleaseMarginMs: config.search.preHomeReleaseMarginMs,
        noticeStream: config.search.noticeStream,
        titlePrecisionTailCut: config.search.titlePrecisionTailCut,
        indexRescueMinMs: config.search.indexRescueMinMs,
      },
      budgets: {
        debridReserveMs: config.debridReserve,
        debridCheckFloorMs: config.debridCheckFloor,
        brPartialGraceMs: config.brPartialGrace,
        searchTimeoutMs: config.searchTimeout,
      },
      display: {
        style: config.streamNameStyle,
        showSource: config.streamNameShowSource,
      },
      jackett: {
        selected: config.jackett.indexers,
        ptBr: config.jackett.ptBrIndexers,
        slow: config.jackett.slowIndexers,
        indexOnly: config.jackett.indexOnlyIndexers,
        sweepEnabled: config.jackett.ptSweepGlobal,
      },
      releaseIndexEnabled: config.releaseIndex.enabled,
      magnetBankEnabled: config.magnetBank?.enabled ?? false,
    },
  });
}
