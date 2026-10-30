// P5 — /stream-trace.json: leitura OFFLINE do ledger de busca + live read-only.
//
// Extraído de diagnostics.ts ao estourar a catraca de 400 linhas (regra do
// repositório: dividir, não bless). A chave é a MESMA do stream request
// (config do segmento + resolveUncached do operador, sem credencial) e a
// leitura é a PONTE NATIVA (`streams.db` do gateway) — o L1 `streams` deste
// processo nasce vazio desde o corte F4.4a e ninguém escreve nele, então o
// caminho getWithStale/keysMatching que vivia aqui era código morto num
// caminho vivo e saiu (dívida 4.2(b)).
//
// Três modos no mesmo handler:
//   offline default — entrada com ledger NÃO recomputa; sem ledger, o GATEWAY
//     recomputa (matéria quente DELE, instalação extraída da própria chave)
//     e devolve `recompute` — aqui é repasse puro (nunca reescreve a entrada;
//     `now` = estado atual, não causa);
//   mode=live       — TorBox/Premiumize APENAS, método cru do adaptador
//     (BY_ID, nunca debrid.checkCached), gateada pela sonda de capacidade
//     (knob STREAM_TRACE_LIVE + kill-switch STREAM_TRACE + conta efetiva):
//     desligado ou recusado => responde SEM tocar a rede;
//   kill-switch     — STREAM_TRACE=false desliga captura, leitura, recompute E
//     live (o boot do gateway lê as MESMAS envs; o 404 sem entrada sintetiza
//     o bloco `recompute` com o knob local).
//
// A resposta NUNCA inclui streams, chave crua, hash, magnet ou apiKey — o
// serializado do trace, o recompute nativo e os resultados do live carregam
// só id/rótulo/veredito.
import { asyncRoute } from './async.js';
import type { AppServices, GateAdmission } from './types.js';
import type express from 'express';
import { streamsCacheKey } from '../utils/request-key.js';
import { serializeTrace, sanitizeTraceLabel } from '../utils/stream-trace.js';
import { liveCapability, liveCheck } from '../debrid/live-check.js';
import { fetchNativeStreamTrace } from '../utils/streams-store-native.js';

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

/**
 * Sonda de CAPACIDADE sempre presente (o painel decide se renderiza o botão) e
 * a execução de `mode=live`, que é gateada por ela: knob desligado, sem conta ou
 * serviço recusado => responde SEM tocar a rede (o GET ao serviço é quota da
 * conta; o operador tem que ter optado).
 *
 * Compartilhada pelas duas origens do ledger (L1 do Node e `streams.db`
 * nativo): a decisão de live não pode divergir entre elas.
 */
async function appendLive(
  services: AppServices,
  mode: unknown,
  base: Record<string, unknown>,
  streams: Array<{ name?: unknown; infoHash?: unknown }>,
): Promise<Record<string, unknown>> {
  const opts = services.runtime.opts();
  const service = opts.debridService || null;
  const apiKey = opts.debridApiKey || '';
  // O kill-switch STREAM_TRACE desliga o live junto (é o interruptor do
  // diagnóstico inteiro); o STREAM_TRACE_LIVE decide se o serviço efetivo
  // está na allowlist.
  const liveEnabled = services.config.search.streamTrace
    && services.config.search.streamTraceLive.includes(String(service || ''));
  const live = liveCapability(service, apiKey, liveEnabled);
  if (String(mode || '') !== 'live' || !live.allowed) return { ...base, live };
  const items = streams.slice(0, services.config.search.streamTraceLiveMaxHashes).map((s, i) => ({
    id: `d${i + 1}`,
    // Mesma defesa do trace/recompute: o name do stream pode carregar
    // magnet/hash cru do cache; o hash em si vai cru ao BY_ID mas some da
    // resposta (liveCheck só devolve id/name/verdict).
    name: sanitizeTraceLabel(String(s.name || '').split('\n')[0]),
    hash: String(s.infoHash || ''),
  })).filter((i) => i.hash);
  const liveResult = await liveCheck(String(service || ''), apiKey, items, {
    timeoutMs: services.config.search.streamTraceLiveTimeoutMs,
    maxHashes: services.config.search.streamTraceLiveMaxHashes,
  });
  return { ...base, live: liveResult };
}

export function makeStreamTraceHandler(services: AppServices): express.RequestHandler {
  return asyncRoute(async (req, res) => {
    if (unavailable(services, req, res, 'diagnóstico desativado pelo operador', { ok: false })) return;
    const admission = services.diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error, reason: admission.reason });
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
      // F4.4a/4.2(b) — o ledger da busca vive no `streams.db` do gateway e o
      // RECOMPUTE também: entrada SEM ledger e COM `searchMeta` chega com o
      // `recompute` já pronto do nativo (a instalação — indexers efetivos e
      // escopo da conta — vem da própria `streamsCacheKey` gravada no store;
      // matéria só de leitura quiet, zero rede, zero gravação).
      const native = await fetchNativeStreamTrace(type, id, cacheKey);
      if (native?.found) {
        const cache = native.cache ?? {};
        const recompute = native.recompute ?? null;
        const base = {
          ok: true,
          found: true,
          origin: recompute ? 'recompute' : 'cached',
          source: 'rust',
          type,
          id,
          cache: {
            remainingS: Number(cache.remainingS) || 0,
            partial: cache.partial === true,
            debridKnown: cache.debridKnown === true,
            stale: cache.stale === true,
          },
          trace: serializeTrace(native.trace as Parameters<typeof serializeTrace>[0]),
          recompute,
        };
        return res.json(await appendLive(services, req.query.mode, base, native.streams ?? []));
      }
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
    } finally {
      admission.release();
    }
  });
}

export { unavailable };
