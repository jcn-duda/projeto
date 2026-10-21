// POST /internal/debrid/check — reserva do orquestrador Rust (Fase A, passo 2).
//
// F4.6: a rota está APOSENTADA como respondedora no default do corte. Com
// `DEBRID_AL_RUST=on` (default do `docker-compose.yml`) ela responde **410** —
// quem responde é a checagem nativa do `adom-search` (e a reserva Node só
// seria usada antes de qualquer upload, quando então vira `Unknown` honesto).
// O caminho `off` continua VIVO e funcional: é o rollback de uma linha
// (`DEBRID_AL_RUST=off`), o mesmo do Rust.
//
// Corpo: `{ encoded, service, hashes, deadline_at }`; o usuário vem no CORPO
// (`encoded` decodificado e executado dentro de `runtime.run`) — invariante:
// a chave do debrid é a do contexto do usuário, nunca do `.env` do operador.
//
// SEM efeito colateral de escrita na conta: a rota só lê (`checkCached` do
// registry). A AllDebrid checa cache via `/magnet/upload` de verdade — os
// fail-safes de limpeza (protected.ts, mayDeleteHash) moram DENTRO do
// adaptador, então chamá-lo aqui não abre buraco; upload COMO FUNCIONALIDADE
// (autofetch/enqueue) fica para o sidecar.
//
// Semântica honesta (AGENTS.md): `known:false` NÃO é "não está em cache";
// `partial:false` não prova que o debrid foi perguntado. Falha por hash isola
// `known:false` + `error`; 500 só para erro estrutural do handler.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import type { DebridAdapter } from '../../types/domain.js';
import { BY_ID, current } from '../debrid/registry.js';
import { checkCached, normalizeCacheResult, unusableReason } from '../debrid/cache-check.js';
import type { CacheCheckResult } from '../debrid/cache-check.js';
import { opts } from '../runtime.js';
import { alRustMode } from '../config/debrid-rust.js';
import * as log from '../utils/logger.js';
import { rejectedByGuard, decodeTarget, withinDeadline, DEADLINE } from './internal-search-shared.js';

// Teto de entrada: a rota recebe hashes de UMA obra por vez na prática; 500
// cobre pack gigante com folga sem virar varredura de acervo.
const MAX_HASHES = 500;

const SERVICES = new Set(['realdebrid', 'torbox', 'alldebrid', 'premiumize', 'debridlink']);

/** Colaboradores trocáveis em teste (mesmo padrão de internal-search). */
export interface InternalDebridCheckCollaborators {
  /** Adaptador por id do registry; trocável para stub sem rede. */
  adapterFor: (service: string) => DebridAdapter | undefined;
  /** Chave do contexto do usuário corrente (lida DENTRO de runtime.run). */
  apiKeyOf: () => string;
  /**
   * A MESMA checagem da busca (`cache-check.checkCached`: davail, prazo,
   * não-abortável), lida DENTRO de runtime.run. `null` = não se aplica (o
   * adaptador do contexto não é o serviço pedido, ou teste com adaptador
   * stub) e a rota cai no `adapter.checkCached` cru.
   */
  availabilityCheck: (service: string, hashes: string[], timeoutMs: number) => Promise<CacheCheckResult> | null;
}

type HashResult = { cached: boolean; known: boolean; unusable?: 'auth' | 'quota'; error?: string; timeout?: true };

function unknownAll(hashes: string[], extra: Partial<HashResult> = {}): Record<string, HashResult> {
  return Object.fromEntries(hashes.map((hash) => [hash, { cached: false, known: false, ...extra }]));
}

async function handleCheck(
  services: AppServices,
  deps: InternalDebridCheckCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { service?: unknown; hashes?: unknown; deadline_at?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });

  const service = typeof body?.service === 'string' ? body.service : '';
  if (!SERVICES.has(service)) {
    return res.status(400).json({ ok: false, error: 'service deve ser realdebrid, torbox, alldebrid, premiumize ou debridlink' });
  }
  const rawHashes = body?.hashes;
  if (!Array.isArray(rawHashes) || !rawHashes.every((h) => typeof h === 'string')) {
    return res.status(400).json({ ok: false, error: 'hashes deve ser array de strings' });
  }
  if (rawHashes.length > MAX_HASHES) {
    return res.status(400).json({ ok: false, error: `hashes acima do teto de ${MAX_HASHES}` });
  }
  const hashes = [...new Set(rawHashes.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  // Prazo ABSOLUTO (epoch ms), mesma semântica do collect: quem decide o
  // orçamento é o orquestrador. Já vencido é bug do chamador (400).
  const deadlineAt = typeof body?.deadline_at === 'number' && Number.isFinite(body.deadline_at) ? body.deadline_at : NaN;
  if (!Number.isFinite(deadlineAt)) return res.status(400).json({ ok: false, error: 'deadline_at (epoch ms) é obrigatório' });
  const budget = deadlineAt - Date.now();
  if (budget <= 0) return res.status(400).json({ ok: false, error: 'deadline_at já venceu' });

  const adapter = deps.adapterFor(service);
  if (!adapter) return res.status(400).json({ ok: false, error: `serviço sem adaptador: ${service}` });
  const ctx = { opts: target.opts, encoded: target.encoded, replyDeadlineMs: budget };

  // Resultado da checagem DENTRO do runtime.run — cada forma vira uma resposta
  // própria, sem sobrecarregar o formato do adaptador.
  type Outcome =
    | { kind: 'not-configured' }
    | { kind: 'no-cache-check' }
    | { kind: 'verdict'; verdict: ReturnType<typeof normalizeCacheResult> }
    | { kind: 'unusable'; reason: 'auth' | 'quota' }
    | { kind: 'failed' };

  try {
    const value = await services.runtime.run(ctx, () => withinDeadline((async (): Promise<Outcome> => {
      const apiKey = deps.apiKeyOf();
      // Sem chave no contexto do `encoded` (P2P puro): não é erro — o
      // orquestrador recebe `configured:false` e trata como P2P.
      if (!apiKey) return { kind: 'not-configured' };
      // Adaptador sem cacheCheck (Debrid-Link; RD sem ledger+oráculo): "não sei"
      // honesto por hash — inventar cached:false apagaria ⚡ real.
      if (!adapter.cacheCheck) return { kind: 'no-cache-check' };
      // Mesmo caminho da busca do Node: sem o davail, o orquestrador Rust
      // perdia o ⚡ que o Node lembra (e a AllDebrid refazia upload a cada
      // busca). O resultado já vem normalizado; unusable vira estado da conta.
      const viaSearch = deps.availabilityCheck(service, hashes, budget);
      if (viaSearch) {
        const result = await viaSearch;
        const reason = result.unusable?.reason;
        if (reason === 'auth' || reason === 'quota') return { kind: 'unusable', reason };
        return { kind: 'verdict', verdict: { cached: result.cached, known: result.known } };
      }
      try {
        return { kind: 'verdict', verdict: normalizeCacheResult(adapter, await adapter.checkCached(apiKey, hashes)) };
      } catch (err) {
        // auth/quota são estado da conta (unusable), não "não sei": o motivo
        // vai por hash. Outra falha isola `known:false` + error, sem lançar.
        const reason = unusableReason(err);
        if (reason) return { kind: 'unusable', reason };
        log.warn(`[internal-debrid] ${service}: checagem falhou:`, log.errorMessage(err));
        return { kind: 'failed' };
      }
    })(), budget));

    if (value === DEADLINE) {
      log.warn(`[internal-debrid] ${service}: prazo de ${Math.round(budget)}ms atingido`);
      // Estourou → parcial com timeout por hash: NENHUM hash pode soar como
      // "não está em cache" — known:false é "não perguntado a tempo".
      return res.json({ ok: true, service, configured: true, partial: true, results: unknownAll(hashes, { timeout: true }) });
    }

    if (value.kind === 'not-configured') {
      return res.json({ ok: true, service, configured: false, partial: false, results: {} });
    }
    if (value.kind === 'no-cache-check') {
      return res.json({ ok: true, service, configured: true, cache_check: false, partial: false, results: unknownAll(hashes) });
    }
    if (value.kind === 'unusable') {
      return res.json({
        ok: true, service, configured: true, partial: true, unusable: value.reason,
        results: unknownAll(hashes, { unusable: value.reason }),
      });
    }
    if (value.kind === 'failed') {
      return res.json({ ok: true, service, configured: true, partial: false, results: unknownAll(hashes, { error: 'falha' }) });
    }
    const { verdict } = value;
    const results: Record<string, HashResult> = {};
    for (const hash of hashes) {
      if (verdict.cached.has(hash)) results[hash] = { cached: true, known: true };
      else results[hash] = { cached: false, known: verdict.known };
    }
    let partial = false;
    if (!verdict.known) {
      // Resposta incompleta/estourada do adaptador: o que não foi CONFIRMADO
      // vira timeout explícito — o Rust distingue de "não tem".
      partial = true;
      for (const hash of hashes) {
        if (!verdict.cached.has(hash)) results[hash] = { cached: false, known: false, timeout: true };
      }
    }
    log.debug(`[internal-debrid] ${service}: ${hashes.length} hash(es), cached=${verdict.cached.size} known=${verdict.known}`);
    return res.json({ ok: true, service, configured: true, partial, results });
  } catch (err) {
    // Erro estrutural (bug do handler, não da rede): 500 curto, log com detalhe.
    log.error('[internal-debrid] check falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao checar cache' });
  }
}

/**
 * Registra POST /internal/debrid/check no router. Mesma guarda das rotas
 * /internal/search/* (loopback + token) e mesma posição no roteador (antes do
 * overlay /:userConfig). O modo vem de `DEBRID_AL_RUST` por requisição:
 * `on` ⇒ 410 (aposentada, F4.6); `off` ⇒ caminho Node vivo.
 */
export function registerInternalDebridCheck(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalDebridCheckCollaborators> = {},
): void {
  // Delegação VIVA no objeto `overrides`: testes trocam o colaborador entre
  // casos sem religar a rota (mesma semântica do registry ESM congelado).
  const deps: InternalDebridCheckCollaborators = {
    adapterFor: (id) => (overrides.adapterFor ?? ((sid) => BY_ID.get(sid)))(id),
    apiKeyOf: () => (overrides.apiKeyOf ?? (() => opts().debridApiKey || ''))(),
    availabilityCheck: (service, hashes, timeoutMs) => {
      if (overrides.availabilityCheck) return overrides.availabilityCheck(service, hashes, timeoutMs);
      // Adaptador trocado (teste) ou contexto de outro serviço: caminho cru.
      if (overrides.adapterFor || current()?.id !== service) return null;
      return checkCached(hashes, { timeoutMs });
    },
  };
  const json = express.json({ limit: '256kb' });
  router.post('/internal/debrid/check', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    // F4.6 — a rota não é mais a respondedora no default do corte. 410 (e não
    // 404) de propósito: diz que o caminho existiu e aponta o rollback, sem
    // fingir que a reserva nunca fez parte do contrato. A guarda acima fica
    // ANTES: fora do loopback/sem token continua 403/401, nunca 410.
    if (alRustMode() === 'on') {
      return res.status(410).json({
        ok: false,
        retired: true,
        error: 'rota aposentada: a checagem nativa da AllDebrid responde (DEBRID_AL_RUST=on); '
          + 'rollback: DEBRID_AL_RUST=off',
      });
    }
    await handleCheck(services, deps, req, res);
  }));
}
