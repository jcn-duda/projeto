// POST /internal/search/collect — um `taskScope` do `collectRaw` com prazo
// ABSOLUTO. Extraído de `internal-search.ts` pela catraca de 400 linhas.
//
// O corpo traz a obra (query/pt/imdb/S/E/ano), o `encoded` do usuário e o
// instante em que a resposta precisa ter saído (`deadline_at`, epoch ms).
// Contrato de resposta: itens crus por indexer (mesma forma do cache `raw:v1`),
// o `LiveIndexerState` em snapshot e o estado do circuit breaker.
//
// `read_only` (F2.1, sombra de fonte): coleta de REFERÊNCIA sem efeitos no
// Node — sem inventário da conta, captura no banco, status/breaker ou cache
// bruto. Só a sombra liga; o caminho de resposta nunca.
import type express from 'express';
import type { MatchContext } from '../../types/domain.js';
import type { AppServices } from './types.js';
import type { InternalSearchCollaborators } from './internal-search.js';
import { collectRaw } from '../providers/collect-orchestrator.js';
import { parseSkipSources } from './internal-search-skip.js';
import { enrichForRust } from './internal-search-evidence.js';
import { decodeTarget, withinDeadline, DEADLINE } from './internal-search-shared.js';
import * as log from '../utils/logger.js';

/** `read_only` ausente = false; presente e não booleano é erro de integração. */
function parseReadOnly(raw: unknown): boolean | null | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === 'boolean' ? raw : null;
}

export async function handleCollect(
  services: AppServices,
  deps: InternalSearchCollaborators,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as {
    task_scope?: unknown; query?: unknown; pt_query?: unknown; type?: unknown; imdb?: unknown;
    season?: unknown; episode?: unknown; year?: unknown; names?: unknown;
    sweep_query?: unknown; original_query?: unknown; multi_work_query?: unknown; deadline_at?: unknown;
    skip_sources?: unknown; read_only?: unknown; shadow_source?: unknown; indexers?: unknown;
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
  // Fontes que o Rust já coleta (lista fechada em internal-search-skip.ts → 400).
  const skipSet = parseSkipSources(body?.skip_sources);
  if (skipSet === null) {
    return res.status(400).json({ ok: false, error: 'skip_sources deve ser subconjunto de jackett, prowlarr, torrentio, bludv, mico, account' });
  }
  const readOnly = parseReadOnly(body?.read_only);
  if (readOnly === null) {
    return res.status(400).json({ ok: false, error: 'read_only deve ser booleano' });
  }
  const shadowSource = str(body?.shadow_source);
  if (readOnly === true && !shadowSource) {
    return res.status(400).json({ ok: false, error: 'shadow_source é obrigatório em read_only' });
  }
  // Elegibilidade da sombra: a MESMA regra de `wants` do collectRaw (mode
  // `both` ou o nome na lista efetiva de providers). Fonte fora da seleção
  // devolve vazio de propósito; comparar isso com o nativo seria divergência
  // falsa. `skip_sources` também desabilita.
  const providers = Array.isArray(target.opts.providers) ? target.opts.providers : [];
  const eligible = readOnly !== true || (
    Boolean(shadowSource)
    && !skipSet?.has(shadowSource!)
    && (providers.includes('both') || providers.includes(shadowSource!))
  );
  if (readOnly === true && !eligible) {
    log.debug(`[internal] collect ${type} ${imdbId}: sombra pulada (${shadowSource} fora dos providers)`);
    return res.json({
      ok: true,
      task_scope: scope,
      query,
      imdb_id: imdbId,
      season,
      episode,
      partial: false,
      items: [],
      by_indexer: {},
      live: null,
      breaker: {},
      eligible: false,
    });
  }
  // Override de indexers da sombra (`JACKETT_INDEXERS` do processo): só
  // read-only; presente e inválido é 400.
  const indexersOverride = body?.indexers === undefined
    ? null
    : (Array.isArray(body.indexers) && body.indexers.every((id: unknown) => typeof id === 'string')
      ? (body.indexers as string[]).map((id) => id.trim()).filter(Boolean)
      : undefined);
  if (readOnly === true && indexersOverride === undefined) {
    return res.status(400).json({ ok: false, error: 'indexers deve ser array de strings' });
  }
  const override = readOnly === true ? indexersOverride : null;
  const ctx = { opts: target.opts, encoded: target.encoded, replyDeadlineMs: budget };

  try {
    const value = await services.runtime.run(ctx, () =>
      withinDeadline(deps.collectRaw(
        query, type, imdbId, ptQuery, matchContext,
        null, sweepQuery, deadlineAt, scope,
        // Sem observador nem trace: a rota é o OLHO do orquestrador, não um
        // /stream — nada aqui estagia timing nem escreve índice.
        null, null, originalQuery, multiWorkQuery, skipSet ?? new Set<string>(),
        readOnly === true,
        override,
      ), budget));

    if (value === DEADLINE) {
      log.warn(`[internal] collect ${type} ${imdbId}: prazo de ${Math.round(budget)}ms atingido`);
      return res.status(504).json({ ok: false, error: 'prazo interno esgotado' });
    }
    // Só a prova de ARQUIVO sai daqui; o ptTitleDual (chip/_dubbed/isBr) o Rust
    // decide in-process pelos títulos do `meta` — sem esperar TMDB na rota.
    value.items = enrichForRust(value.items);
    // Itens crus agrupados por indexer — mesma unidade do cache `raw:v1`
    // (array de RawItem por fonte). Fonte sem rótulo vira "sem-indexer": o
    // orquestrador decide o que fazer, a rota não descarta item.
    const byIndexer: Record<string, any[]> = {};
    for (const item of value.items) {
      const key = String(item?.indexer || item?.Indexer || item?.tracker || '').trim() || 'sem-indexer';
      (byIndexer[key] ||= []).push(item);
    }
    // Sombra: NÃO lê o breaker (nem devolve foto) — o estado global do Node
    // não pode influenciar a comparação de fonte.
    let breaker: Record<string, unknown> = {};
    if (readOnly !== true) {
      // O breaker é foto POR indexer: cobre quem apareceu no lote e quem o
      // estado vivo marcou (falho/pendente/vazio) — o conjunto que o Rust
      // precisa para decidir fallback sem uma segunda viagem.
      const breakerIds = new Set<string>(Object.keys(byIndexer));
      if (value.live) {
        for (const id of value.live.failed.keys()) breakerIds.add(id);
        for (const id of value.live.pending) breakerIds.add(id);
        for (const id of value.live.empty) breakerIds.add(id);
        for (const id of value.live.served) breakerIds.add(id);
      }
      breaker = Object.fromEntries([...breakerIds].sort().map((id) => [id, deps.breakerSnapshot(id)]));
    }
    log.debug(`[internal] collect ${type} ${imdbId} [${scope}]: ${value.items.length} item(ns), partial=${value.partial}${readOnly ? ', read-only' : ''}`);
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
      // Caminho de resposta (não-sombra) sempre elegível.
      eligible: true,
    });
  } catch (err) {
    // Erro inesperado (bug, não rede — rede vira `[]` dentro do collectRaw):
    // 500 curto e o log fica com o detalhe.
    log.error('[internal] collect falhou:', err);
    return res.status(500).json({ ok: false, error: 'falha interna ao coletar' });
  }
}
