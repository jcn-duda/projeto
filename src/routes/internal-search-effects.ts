// Rota interna de EFEITOS da busca (Fase A, passo 2 da migração strangler
// Node→Rust): POST /internal/search/effects. O orquestrador Rust (`adom-search`)
// pede ao Node o lote de efeitos DEPOIS do `collect`, mas a rota não executa
// mais nenhum kind: todos são donos do gateway. O `harvester_enqueue` é
// consumido pelo próprio gateway (`rust/crates/adom-server/src/harvest_effect.rs`,
// commit 3ab92ad5); o trabalho do Chupim (`autofetch`, `autofetch_batch`,
// `br_probe`, `season_key`) e o warmer do RD (`rd_warmer`) também. Quando o
// gateway devolve algum deles para cá (`Deferred`/`Forward` sem dono), a rota só
// CONTA e avisa — executar aqui seria dono duplicado do mesmo lote.
//
// Mesmo padrão do `collect` (internal-search.ts): sem config na URL — o usuário
// vem no CORPO (`encoded`), que só é validado aqui. effects é fire-and-forget —
// a resposta (202) NUNCA depende do efeito, porque não há efeito rodando.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import * as log from '../utils/logger.js';

// Teto de entrada: a rota recebe um lote de efeitos, nunca acervo inteiro.
const MAX_EFFECTS = 100;
/** Teto de cada lista do lote do Chupim: o pool pós-debrid é
 *  `maxResults × candidatePoolFactor` (100 × 4 no teto do SCHEMA), com folga. */
const MAX_AUTOFETCH_ITEMS = 400;

const IMDB_RE = /^tt\d+$/;

/**
 * Kinds cujo dono é o gateway. Todos são aceitos na forma (recusar faria o 202
 * mentir sobre o lote que o gateway já classificou), somados em `nativeOnly` e
 * nunca executados aqui. Os donos: `NativeTailEffects`
 * (`rust/crates/adom-server/src/tail_effects.rs`) entrega o trabalho do Chupim
 * ao `NativeWorkQueue` do worker nativo; o `harvester_enqueue` cai na fila do
 * colhedor do gateway; o `rd_warmer` é do sink do warmer RD.
 *
 * Como `Deferred` e o `Forward` de worker desligado desembocam neste aceite, o
 * lote com `nativeOnly > 0` sai com UM `warn`: aceite silencioso é trabalho
 * perdido sem rastro.
 */
const NATIVE_ONLY_KINDS: ReadonlySet<string> = new Set([
  'autofetch', 'autofetch_batch', 'br_probe', 'season_key', 'rd_warmer', 'harvester_enqueue',
]);

/**
 * Valida o lote de efeitos. Cada `kind` tem forma própria de payload — validar
 * aqui (400 no rejeitado como um todo, `rejected` no parcial) evita que um
 * payload malformado chegue ao log do gateway como trabalho aceito.
 *
 * `accepted` conta TODO efeito com forma válida (o mesmo número que o lote
 * declara); `nativeOnly` diz quantos deles são do gateway. `nativeKinds` é a
 * lista desses kinds (só os nomes, nunca o payload) para o aviso do aceite.
 */
function parseEffects(raw: unknown): {
  accepted: number;
  nativeOnly: number;
  nativeKinds: string[];
  rejected: number;
} {
  const nativeKinds: string[] = [];
  let accepted = 0;
  let rejected = 0;
  if (!Array.isArray(raw)) return { accepted, nativeOnly: 0, nativeKinds, rejected };
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown>;
    const kind = typeof item?.kind === 'string' ? item.kind : '';
    const payload = (item?.payload && typeof item.payload === 'object' && !Array.isArray(item.payload))
      ? item.payload as Record<string, unknown> : null;
    const okShape = (() => {
      if (!payload) return false;
      switch (kind) {
        case 'autofetch':
          return Boolean(payload.candidate && payload.request
            && typeof payload.candidate === 'object' && typeof payload.request === 'object');
        case 'autofetch_batch':
          // Forma grosseira: um payload sem lista não vira varredura no dono.
          return Array.isArray(payload.items)
            && payload.items.length <= MAX_AUTOFETCH_ITEMS
            && Array.isArray(payload.cached)
            && payload.cached.length <= MAX_AUTOFETCH_ITEMS
            && typeof payload.known === 'boolean';
        case 'rd_warmer':
          return Array.isArray(payload.releases);
        case 'br_probe':
          return typeof payload.imdbId === 'string' && IMDB_RE.test(payload.imdbId)
            && (payload.type === 'movie' || payload.type === 'series');
        case 'harvester_enqueue':
          return typeof payload.imdbId === 'string' && IMDB_RE.test(payload.imdbId)
            && typeof payload.reason === 'string';
        case 'season_key':
          return typeof payload.adapter_id === 'string' && typeof payload.account === 'string'
            && typeof payload.imdb === 'string' && IMDB_RE.test(payload.imdb)
            && typeof payload.season === 'number' && typeof payload.cache_key === 'string';
        default:
          return false; // kind desconhecido: rejeitado, nunca lança
      }
    })();
    if (!okShape || !payload) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    if (NATIVE_ONLY_KINDS.has(kind)) nativeKinds.push(kind);
  }
  return { accepted, nativeOnly: nativeKinds.length, nativeKinds, rejected };
}

/** `autofetch×1, br_probe×2` — resumo por kind, sem tocar no payload. */
function kindSummary(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${kind}×${n}`).join(', ');
}

/**
 * POST /internal/search/effects — aceite sem execução.
 * `{ encoded, effects: [...] }` → **202** `{ ok, accepted, rejected, nativeOnly }`.
 * O `encoded` é validado (um lote de outra instalação não entra) mas nada é
 * agendado: a resposta sai na hora e não depende de nenhum efeito.
 */
function handleEffects(
  services: AppServices,
  req: express.Request,
  res: express.Response,
) {
  const body = req.body as { effects?: unknown } | undefined;
  const target = decodeTarget(services, body);
  if (!target) return res.status(400).json({ ok: false, error: 'encoded ausente ou inválido' });
  if (!Array.isArray(body?.effects)) return res.status(400).json({ ok: false, error: 'effects deve ser array' });
  if (body.effects.length > MAX_EFFECTS) {
    return res.status(400).json({ ok: false, error: `effects acima do teto de ${MAX_EFFECTS}` });
  }
  const { accepted, nativeOnly, nativeKinds, rejected } = parseEffects(body.effects);
  if (nativeOnly > 0) {
    // Um warn por request, só com kind e contagem — payload não entra em log.
    // Se o lote chegou aqui por `Deferred`/`Forward` do gateway (worker off,
    // sem escopo de conta ou canal cheio), nada foi enfileirado: o dono
    // nativo precisa ser religado.
    log.warn(
      `[internal] effects: nativeOnly=${nativeOnly} (${kindSummary(nativeKinds)}) aceitos sem execução local —`
      + ' o dono destes kinds é o gateway nativo (colhedor, worker do Chupim / warmer RD); o Node só confirma o 202.'
      + ' Se chegaram aqui por `Deferred`/`Forward` do gateway (worker off,'
      + ' sem escopo de conta ou canal cheio), nada foi enfileirado: religue o dono nativo.',
    );
  }
  log.debug(`[internal] effects: accepted=${accepted} nativeOnly=${nativeOnly} rejected=${rejected}`);
  return res.status(202).json({ ok: true, accepted, rejected, nativeOnly });
}

/**
 * Registra a rota de efeitos. Chamado por `registerInternalSearch`, junto das
 * rotas de leitura (montadas ANTES do overlay `/:userConfig`).
 */
export function registerInternalSearchEffects(router: Router, services: AppServices): void {
  const json = express.json({ limit: '1mb' });

  router.post('/internal/search/effects', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleEffects(services, req, res);
  }));
}
