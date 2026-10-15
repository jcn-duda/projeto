// Ações do banco de magnets no /dashboard-action.json (Fase 3 + Etapa 5).
//
// - magnet-inspect: NÃO destrutiva — lista entradas do L1 com filtros.
// - magnet-clear-bad: DESTRUTIVA (confirm central) — apaga registros `bad`.
// - magnet-summary: NÃO destrutiva — agregado por adapter × side.
// - magnet-bank-summary: NÃO destrutiva — panorama do banco vivo (magnet-bank).
// - magnet-bank-search: NÃO destrutiva — busca read-only por hash/título no
//   banco vivo (allowlist de campos, teto de 100).
//
// Segurança de payload: nenhuma resposta inclui apiKey, accountScope (digest
// da conta), nem chave interna completa — o parse das chaves mag descarta o
// digest na origem (magnetdb-inspect) e os handlers só ecoam os filtros
// validados. Teto de 100 itens por resposta/passagem em todas as ações.

import type express from 'express';
import type { AppServices } from './types.js';
import config from '../config.js';
import { MAG_SIDES, magInspect, magClearBads, magSummary, type MagFilters, type MagSide } from '../utils/magnetdb-inspect.js';
import { searchBank } from '../utils/magnet-bank-search.js';

type ActionDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type MagnetAction = (deps: ActionDeps) => Promise<express.Response> | express.Response;

// Teto duro por chamada: a varredura é O(namespace mag) no L1, e a resposta
// não precisa de mais que isso para o operador decidir.
const MAX_ITEMS = 100;
const DEFAULT_ITEMS = 50;

// Mesmo padrão do namespace de cache: id de indexer/adapter é curto e seguro.
const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const HASH_RE = /^[a-f0-9]{40}$/;

type Parsed = { ok: true; filters: MagFilters; limit: number } | { ok: false; error: string };

/**
 * Filtros comuns do corpo: adapterId, side e hash — cada um opcional e
 * validado; valor inválido é 400, não silenciosamente ignorado (o operador
 * acharia que filtrou quando listou tudo).
 */
function parseFilters(req: express.Request, opts: { withSide: boolean }): Parsed {
  const filters: MagFilters = {};
  const body = req.body || {};
  if (body.adapterId != null && body.adapterId !== '') {
    if (typeof body.adapterId !== 'string' || !ADAPTER_ID_RE.test(body.adapterId)) {
      return { ok: false, error: 'adapterId inválido' };
    }
    filters.adapterId = body.adapterId;
  }
  if (opts.withSide && body.side != null && body.side !== '') {
    if (typeof body.side !== 'string' || !(MAG_SIDES as readonly string[]).includes(body.side)) {
      return { ok: false, error: `side inválido; use um de: ${MAG_SIDES.join(', ')}` };
    }
    filters.side = body.side as MagSide;
  }
  if (body.hash != null && body.hash !== '') {
    const hash = String(body.hash).toLowerCase();
    if (!HASH_RE.test(hash)) {
      return { ok: false, error: 'hash inválido; informe o infoHash de 40 hex' };
    }
    filters.hash = hash;
  }
  const raw = body.max;
  const limit = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_ITEMS, Math.trunc(raw))
    : DEFAULT_ITEMS;
  return { ok: true, filters, limit };
}

const echoFilters = (filters: MagFilters): Record<string, string> => {
  const out: Record<string, string> = {};
  if (filters.adapterId) out.adapterId = filters.adapterId;
  if (filters.side) out.side = filters.side;
  if (filters.hash) out.hash = filters.hash;
  return out;
};

/** NÃO destrutiva: enumera o banco (L1) com filtros, teto de itens e TTL restante. */
export const magnetInspect: MagnetAction = ({ services, req, res, action }) => {
  const parsed = parseFilters(req, { withSide: true });
  if (!parsed.ok) return res.status(400).json({ ok: false, action, error: parsed.error });
  const result = magInspect(parsed.filters, parsed.limit);
  services.metrics.count('dashboard.magnet.inspect');
  return res.json({
    ok: true,
    action,
    enabled: config.magnetDb.enabled,
    filters: echoFilters(parsed.filters),
    limit: parsed.limit,
    matched: result.matched,
    returned: result.items.length,
    truncated: result.truncated,
    items: result.items,
  });
};

/** NÃO destrutiva: agregado por adapter × side numa passada — sem hash no payload. */
export const magnetSummary: MagnetAction = ({ services, res, action }) => {
  const summary = magSummary();
  services.metrics.count('dashboard.magnet.summary');
  return res.json({ ok: true, action, enabled: config.magnetDb.enabled, ...summary });
};

/**
 * NÃO destrutiva: panorama do banco VIVO do Jackett (`magnet-bank`), separado
 * do `magnet-summary` (estoque por conta). Totais, último visto e quebra por
 * indexer; a engine agrega numa passada, sem N+1.
 */
export const magnetBankSummary: MagnetAction = ({ services, res, action }) => {
  services.metrics.count('dashboard.magnet.bank_summary');
  return res.json({ ok: true, action, ...services.magnetBank.status() });
};

/**
 * NÃO destrutiva: busca READ-ONLY no banco vivo por hash (40 hex) OU substring
 * de título. Query vazia devolve os recentes (limitados); texto de 1 caractere
 * é 400 — não há varredura ampla. Teto de 100 itens. Payload por allowlist
 * (URI, metadados, fontes e obras), sem credencial nem digest de conta.
 */
export const magnetBankSearch: MagnetAction = ({ services, req, res, action }) => {
  const body = req.body || {};
  if (body.query != null && typeof body.query !== 'string') {
    return res.status(400).json({ ok: false, action, error: 'query inválida; informe hash ou trecho do título' });
  }
  const result = searchBank(body.query ?? '', body.max);
  if (!result.ok) {
    return res.status(400).json({ ok: false, action, error: result.error });
  }
  services.metrics.count('dashboard.magnet.bank_search');
  // `result` já carrega `ok:true` (o ramo de erro saiu no `if` acima); o spread
  // evita repetir a chave e o `action` identifica a ação na resposta.
  return res.json({ ...result, action });
};

/**
 * DESTRUTIVA (confirm central): apaga registros `bad` casados pelos filtros,
 * até `limit` por passagem. Idempotente — repetir devolve cleared 0. Só
 * `bad`: alive/lie do mesmo hash não são tocados, e a contagem durável por
 * adapter fica coerente pelo hook onForget do magnetdb.
 */
export const magnetClearBad: MagnetAction = ({ services, req, res, action }) => {
  const parsed = parseFilters(req, { withSide: true });
  if (!parsed.ok) return res.status(400).json({ ok: false, action, error: parsed.error });
  if (parsed.filters.side && parsed.filters.side !== 'bad') {
    return res.status(400).json({ ok: false, action, error: 'magnet-clear-bad só apaga o lado "bad"' });
  }
  const result = magClearBads({ ...parsed.filters, side: 'bad' }, parsed.limit);
  services.metrics.count('dashboard.magnet.clear_bad', result.cleared);
  services.log.info(
    `[dashboard] magnetdb: ${result.cleared} registro(s) bad apagado(s)${result.remaining ? `, ${result.remaining} restante(s) para a próxima passagem` : ''}`,
  );
  return res.json({
    ok: true,
    action,
    filters: echoFilters({ ...parsed.filters, side: 'bad' }),
    limit: parsed.limit,
    cleared: result.cleared,
    remaining: result.remaining,
  });
};
