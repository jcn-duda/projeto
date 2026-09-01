// P5 — /stream-trace.json: leitura OFFLINE do ledger de busca + live read-only.
//
// Extraído de diagnostics.ts ao estourar a catraca de 400 linhas (regra do
// repositório: dividir, não bless). A chave é a MESMA do stream request
// (config do segmento + resolveUncached do operador, sem credencial) e a
// leitura é getWithStale — nunca peek — para enxergar exatamente o que a
// busca enxerga, inclusive a entrada expirada dentro da janela de graça.
//
// Três modos no mesmo handler:
//   offline default — entrada com trace (inclusive stale) NÃO recomputa; sem
//     trace, recompute offline com matéria-prima local e peeks quiet (nunca
//     rede, nunca reescreve a entrada; `now` = estado atual, não causa);
//   mode=live       — TorBox/Premiumize APENAS, método cru do adaptador
//     (BY_ID, nunca debrid.checkCached), gateada pela sonda de capacidade
//     (knob STREAM_TRACE_LIVE + kill-switch STREAM_TRACE + conta efetiva):
//     desligado ou recusado => responde SEM tocar a rede;
//   kill-switch     — STREAM_TRACE=false desliga captura, leitura, recompute E
//     live (é o interruptor do diagnóstico inteiro).
//
// A resposta NUNCA inclui streams, chave crua, hash, magnet ou apiKey — o
// serializado do trace e os resultados do live carregam só id/rótulo/veredito.
import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { streamsCacheKey } from '../utils/request-key.js';
import { serializeTrace } from '../utils/stream-trace.js';
import { recomputeOffline } from '../utils/trace-recompute.js';
import { liveCapability, liveCheck } from '../debrid/live-check.js';

/** Gate comum dos diagnósticos: sem JACKETT_TEST_TOKEN no .env a rota fica
 * desligada (503, mesmo com header correto); com token, header errado ou
 * ausente devolve 401 — só `X-Indexer-Test-Token`, nunca `?token=`. Mesma
 * implementação da que vivia em diagnostics.ts (services.authorized). */
function unavailable(services: AppServices, req: express.Request, res: express.Response, message: string, shape: Record<string, unknown> = {}) {
  if (!services.config.jackett.testToken) {
    res.status(503).json({ ...shape, error: message });
    return true;
  }
  if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
    res.status(401).json({ ...shape, error: 'token de diagnóstico inválido' });
    return true;
  }
  return false;
}

export function makeStreamTraceHandler(services: AppServices): express.RequestHandler {
  return asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      const type = String(req.query.type || '');
      const id = String(req.query.id || '');
      if (type !== 'movie' && type !== 'series') {
        return res.status(400).json({ ok: false, error: 'type deve ser movie ou series' });
      }
      if (!/^tt\d+(?::\d+){0,2}$/.test(id)) {
        return res.status(400).json({ ok: false, error: 'id deve ser tt\\d+ opcionalmente com :s:e' });
      }
      // Mesma derivação de search-cache.ts:62-63. Fora do segmento, opts() são
      // os defaults — que é exatamente como a busca sem config roda.
      const cacheKey = streamsCacheKey(type, id, {
        ...services.runtime.opts(),
        resolveUncached: services.config.debrid.resolveUncached,
      });
      const hit = services.cache.getWithStale(cacheKey, services.config.streamStaleGrace);
      if (!hit) {
        // Sem entrada NÃO há searchMeta (nomes/ano) nem lista para explicar: o
        // recompute não tem o que dizer. Knob desligado => nem tentou.
        const recomputeOff = !(services.config.search.streamTrace && services.config.search.streamTraceRecompute);
        return res.status(404).json({
          ok: true,
          found: false,
          recompute: recomputeOff
            ? { attempted: false, basis: [], built: false, note: 'disabled' }
            : { attempted: true, basis: [], built: false, note: 'no-material' },
        });
      }
      const value = (hit.value ?? {}) as {
        partial?: boolean;
        debridKnown?: boolean;
        trace?: unknown;
        searchMeta?: { names?: string[]; year?: number | null } | null;
        streams?: Array<{ name?: string; infoHash?: string }>;
      };
      const hasTrace = value.trace != null;
      // P5 Fatia A — recompute OFFLINE. Entrada COM trace (inclusive stale na
      // graça) NÃO recomputa: o ledger já explica. Sem trace, tenta reconstruir
      // o que dá com matéria-prima local (idx/raw/inventário) e peeks quiet —
      // nunca rede, nunca reescreve a entrada. `now` = estado atual, não causa.
      let recompute: ReturnType<typeof recomputeOffline> | null = null;
      if (!hasTrace && services.config.search.streamTrace && services.config.search.streamTraceRecompute) {
        const [imdbId, sRaw, eRaw] = id.split(':');
        const season = sRaw ? Number(sRaw) || null : null;
        const episode = eRaw ? Number(eRaw) || null : null;
        const names = value.searchMeta?.names ?? [];
        const year = value.searchMeta?.year ?? null;
        recompute = recomputeOffline(imdbId, { season, episode }, names, year);
      }
      // P5 Fatia B — sonda de CAPACIDADE sempre presente (o painel decide se
      // renderiza o botão). A EXECUÇÃO de `mode=live` é gateada por ela: knob
      // desligado, sem conta ou serviço recusado => responde sem tocar a rede
      // (o GET ao serviço é quota da conta; o operador tem que ter optado).
      const opts = services.runtime.opts();
      const service = opts.debridService || null;
      const apiKey = opts.debridApiKey || '';
      // O kill-switch STREAM_TRACE desliga o live junto (é o interruptor do
      // diagnóstico inteiro); o STREAM_TRACE_LIVE decide se o serviço efetivo
      // está na allowlist.
      const liveEnabled = services.config.search.streamTrace
        && services.config.search.streamTraceLive.includes(String(service || ''));
      const live = liveCapability(service, apiKey, liveEnabled);
      const base = {
        ok: true,
        found: true,
        origin: hasTrace ? 'cached' : 'recompute',
        type,
        id,
        cache: {
          remainingS: services.cache.peekRemaining(cacheKey) ?? 0,
          partial: value.partial === true,
          debridKnown: value.debridKnown === true,
          stale: hit.stale === true,
        },
        trace: serializeTrace(value.trace as Parameters<typeof serializeTrace>[0]),
        recompute,
      };
      if (String(req.query.mode || '') === 'live') {
        if (!live.allowed) return res.json({ ...base, live });
        const streams = Array.isArray(value.streams) ? value.streams : [];
        const items = streams.slice(0, services.config.search.streamTraceLiveMaxHashes).map((s, i) => ({
          id: `d${i + 1}`,
          name: String(s.name || '').split('\n')[0],
          hash: String(s.infoHash || ''),
        })).filter((i) => i.hash);
        const liveResult = await liveCheck(String(service || ''), apiKey, items, {
          timeoutMs: services.config.search.streamTraceLiveTimeoutMs,
          maxHashes: services.config.search.streamTraceLiveMaxHashes,
        });
        return res.json({ ...base, live: liveResult });
      }
      return res.json({ ...base, live });
    } finally {
      admission.release();
    }
  });
}

export { unavailable };
