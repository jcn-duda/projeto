// POST /internal/debrid/holds — feed dos holds do autofetch para o gateway
// in-process (`adom-search::debrid_seam`), ligado por `DEBRID_AL_HOLDS=on`.
//
// POR QUE ESTA ROTA EXISTE: a checagem nativa da AllDebrid (`DEBRID_AL_RUST=on`)
// só apaga com `holdsComplete` + inventário (`adom-debrid::alldebrid_cleanup`).
// O hold volátil do autofetch mora NESTE processo (memória), então o seam
// in-process não o enxerga — e a nativa ficaria read-only para sempre. O
// caminho do sidecar (8710) já recebe os fatos no corpo do `/debrid/check`; o
// gateway fala com o Node por loopback e precisa do mesmo conjunto antes de
// rodar a nativa.
//
// CONTRATO: corpo `{ encoded, service, hashes }` (a chave NUNCA vai no JSON: o
// `encoded` é decodificado e a chave sai do runtime do usuário, como em
// `/internal/debrid/check`). Resposta:
// `{ ok, service, account, inventoryLoaded, knownBefore, heldHashes,
//    evaluated, holdsComplete, dropReady, dropUncached }`.
// O Rust confere `account == account_scope(apiKey)` e `evaluated ⊇ hashes`
// antes de aceitar `holdsComplete` — o flag sozinho não autoriza nada.
//
// FAIL-CLOSED: chave vazia, hash ilegível ou falha na leitura durável ⇒
// `holdsComplete:false` (e `evaluated` só com o que foi provado). Sem resposta
// ou erro HTTP, o gateway mantém a nativa read-only.
//
// Só AllDebrid: os demais serviços não têm hold/`adprot` e a rota responde 400
// (o gateway nem a chama para eles).
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import type { HoldsFeedFacts } from '../debrid/alldebrid-cleanup-facts.js';
import { alldebridHoldsFeedFacts } from '../debrid/alldebrid-cleanup-facts.js';
import { id as alldebridId } from '../debrid/alldebrid-api.js';
import { opts } from '../runtime.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';

// Mesmo teto de `/internal/debrid/check`: o lote é de UMA obra na prática.
const MAX_HASHES = 500;

/** Colaboradores trocáveis em teste (mesmo padrão das outras rotas internas). */
export interface InternalDebridHoldsCollaborators {
  /** Chave do contexto do usuário corrente (lida DENTRO de runtime.run). */
  apiKeyOf: () => string;
  /** Levantamento dos holds; trocável para testar o fio sem cache/rede. */
  factsFor: (apiKey: string, hashes: readonly string[]) => HoldsFeedFacts;
}

async function handleHolds(
  services: AppServices,
  deps: InternalDebridHoldsCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { service?: unknown; hashes?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  const service = typeof body?.service === 'string' ? body.service : '';
  if (service !== alldebridId) {
    return res.status(400).json({ ok: false, error: `holds só existe para ${alldebridId}` });
  }
  const rawHashes = body?.hashes;
  if (!Array.isArray(rawHashes) || !rawHashes.every((h) => typeof h === 'string')) {
    return res.status(400).json({ ok: false, error: 'hashes deve ser array de strings' });
  }
  if (rawHashes.length > MAX_HASHES) {
    return res.status(400).json({ ok: false, error: `hashes acima do teto de ${MAX_HASHES}` });
  }
  // Dedupe preservando a ordem; hash vazio NÃO é descartado aqui: a auditoria
  // o marca como ilegível e derruba `holdsComplete` (fail-closed) — o gateway
  // também confere a cobertura do lote por conta própria.
  const hashes = [...new Set(rawHashes.map((h) => h.trim()))];

  try {
    // A chave vem do contexto do `encoded`, nunca do `.env` do operador.
    const facts = services.runtime.run(
      { opts: target.opts, encoded: target.encoded },
      () => deps.factsFor(deps.apiKeyOf() || '', hashes),
    );
    metrics.count('rust.debrid.holds.feed');
    if (!facts.holdsComplete) metrics.count('rust.debrid.holds.incomplete');
    return res.json({ ok: true, service, ...facts });
  } catch (err) {
    // Erro estrutural (bug do handler): o gateway trata como feed indisponível
    // e mantém a nativa read-only. Nunca inventa hold nem inventário.
    log.error('[internal-debrid] holds falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao montar os holds' });
  }
}

/**
 * Registra POST /internal/debrid/holds no router. Mesma guarda das rotas
 * `/internal/search/*` (loopback + token) e mesma posição (antes do overlay
 * `/:userConfig`).
 */
export function registerInternalDebridHolds(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalDebridHoldsCollaborators> = {},
): void {
  const deps: InternalDebridHoldsCollaborators = {
    apiKeyOf: () => (overrides.apiKeyOf ?? (() => opts().debridApiKey || ''))(),
    factsFor: (apiKey, hashes) => (overrides.factsFor ?? alldebridHoldsFeedFacts)(apiKey, hashes),
  };
  const json = express.json({ limit: '256kb' });
  router.post('/internal/debrid/holds', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    await handleHolds(services, deps, req, res);
  }));
}
