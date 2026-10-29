// Rotas internas de ESCRITA E EFEITOS da busca (Fase A, passo 2 da migração
// strangler Node→Rust): POST /internal/search/effects. É o que o orquestrador
// Rust (`adom-search`) pede ao Node DEPOIS do `collect`: disparar os efeitos de
// fundo que AINDA moram aqui — o pedido ao colhedor. A captura do banco VIVO e
// o índice são NATIVOS desde o R4 (a rota `index-write` e o efeito
// `magnet_capture` foram removidos junto com os ramos Node); o interrogatório
// de áudio (`dub_audit`) saiu na T3-L7a; o trabalho do Chupim (`autofetch`
// legado, `autofetch_batch`, `br_probe`, `season_key`) passou ao worker nativo
// na leva B4 e o warmer do RD (`rd_warmer`) ao gateway na fatia 1 da Fase 2 —
// aqui eles são só CONTADOS, nunca executados, e o lote com esse trabalho sai
// com UM `warn` (aceite mudo seria trabalho perdido).
//
// Mesmo padrão do `collect` (internal-search.ts): sem config na URL — o usuário
// vem no CORPO (`encoded`), e o contexto é restaurado com `runtime.run` (o
// `capture()` cobre o invariante de timer/promise pós-request). effects é
// fire-and-forget — a resposta (202) NUNCA depende do efeito rodar.
import express, { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { rejectedByGuard, decodeTarget } from './internal-search-shared.js';
import { enqueueNativeHarvest } from '../utils/harvest-native.js';
import type { NativeHarvestEnqueue } from '../utils/harvest-native.js';
import * as runtime from '../runtime.js';
import * as log from '../utils/logger.js';

// Teto de entrada: a rota recebe um lote de efeitos, nunca acervo inteiro.
const MAX_EFFECTS = 100;
/** Teto de cada lista do lote do Chupim: o pool pós-debrid é
 *  `maxResults × candidatePoolFactor` (100 × 4 no teto do SCHEMA), com folga. */
const MAX_AUTOFETCH_ITEMS = 400;

const IMDB_RE = /^tt\d+$/;

/**
 * Kinds cujo dono é o gateway. O `NativeTailEffects`
 * (`rust/crates/adom-server/src/tail_effects.rs`) entrega o payload ao
 * `NativeWorkQueue` do worker nativo do Chupim, que despacha por `kind`
 * (`autofetch_batch` → enqueue/recheck/dreno, `br_probe` → `probe_job`,
 * `season_key` → `season_step`); o `autofetch` legado é o mesmo lote em outro
 * formato. O `rd_warmer` é do sink nativo do gateway (warmer RD): a fila vive
 * no `/rd-warm` da admin 8711 e este processo só a lê pela ponte.
 *
 * A leva B4 já apagou os donos do Chupim no TS e a fatia 1 da Fase 2 apagou o
 * warmer (`rd-warmer`/`harvest-warmer`): não há mais para onde executar aqui.
 * Eles continuam ACEITOS na validação de forma — recusar faria o 202 mentir
 * sobre o lote que o gateway já classificou —, engordam `nativeOnly` e não
 * chamam nada. Como `Deferred` (`tail_effects.rs`) e o `Forward` de worker
 * desligado desembocam ambos neste aceite, o lote com `nativeOnly > 0` sai com
 * UM `warn`: aceite silencioso é trabalho perdido sem rastro.
 */
const NATIVE_ONLY_KINDS: ReadonlySet<string> = new Set([
  'autofetch', 'autofetch_batch', 'br_probe', 'season_key', 'rd_warmer',
]);

/** Colaboradores trocáveis em teste (mesmo padrão do internal-search.ts). */
export interface InternalSearchEffectsCollaborators {
  /** Enfileira obra no colhedor NATIVO (`POST /harvest/enqueue` do gateway). */
  harvestEnqueue: (req: NativeHarvestEnqueue) => void;
}

/** Efeito que este processo executa: `kind` discriminado + payload validado. */
type Effect = { kind: 'harvester_enqueue'; payload: Record<string, unknown> };

/**
 * Payload do efeito → pedido do colhedor NATIVO. O contrato do gateway não
 * aceita `null` em S/E (ausente = obra inteira) e recusa `type` fora de
 * `movie|series` — pedido sem tipo é descartado aqui, nunca convertido em
 * filme por omissão.
 */
function nativeHarvestRequest(
  p: Record<string, unknown>,
  reason: string,
): NativeHarvestEnqueue | null {
  const type = p.type === 'series' ? 'series' : p.type === 'movie' ? 'movie' : null;
  if (!type) return null;
  return {
    imdbId: String(p.imdbId),
    type,
    reason,
    ...(typeof p.season === 'number' ? { season: p.season } : {}),
    ...(typeof p.episode === 'number' ? { episode: p.episode } : {}),
  };
}

/**
 * Valida o lote de efeitos. Cada `kind` tem forma própria de payload — validar
 * aqui (400 no rejeitado como um todo, `rejected` no parcial) evita que um
 * payload malformado vire exceção assíncrona num timer, longe do chamador.
 *
 * `accepted` conta TODO efeito com forma válida (o mesmo número que o lote
 * declara); `nativeOnly` diz quantos deles são do gateway e `effects` carrega
 * só os que este processo executa. `nativeKinds` é a lista desses kinds (só os
 * nomes, nunca o payload) para o aviso do aceite sem execução.
 */
function parseEffects(raw: unknown): {
  effects: Effect[];
  accepted: number;
  nativeOnly: number;
  nativeKinds: string[];
  rejected: number;
} {
  const effects: Effect[] = [];
  const nativeKinds: string[] = [];
  let accepted = 0;
  let nativeOnly = 0;
  let rejected = 0;
  if (!Array.isArray(raw)) return { effects, accepted, nativeOnly, nativeKinds, rejected };
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
    if (NATIVE_ONLY_KINDS.has(kind)) {
      nativeOnly += 1;
      nativeKinds.push(kind);
    } else {
      effects.push({ kind: kind as Effect['kind'], payload });
    }
  }
  return { effects, accepted, nativeOnly, nativeKinds, rejected };
}

/** `autofetch×1, br_probe×2` — resumo por kind, sem tocar no payload. */
function kindSummary(kinds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${kind}×${n}`).join(', ');
}

/** Executa UM efeito aceito. Cada função enfileira e volta — nada bloqueia. */
function runEffect(deps: InternalSearchEffectsCollaborators, effect: Effect): void {
  const p = effect.payload;
  switch (effect.kind) {
    case 'harvester_enqueue': {
      // `next-episode`/`miss`/`gap`/`br-gap` do Rust: o enfileiramento é do
      // gateway (fila, dedupe de 12h e prioridade são dele). A flag `brProbe`
      // só viaja quando o pedido veio como sonda dirigida — o Rust hoje não a
      // manda, mas o contrato do gateway a preserva.
      const req = nativeHarvestRequest(p, String(p.reason));
      if (req) deps.harvestEnqueue(p.brProbe === true ? { ...req, brProbe: true } : req);
      return;
    }
  }
}

/**
 * POST /internal/search/effects — fire-and-forget.
 * `{ encoded, effects: [...] }` → **202** `{ ok, accepted, rejected, nativeOnly }`
 * na HORA: o prazo da resposta nunca depende do efeito (só enfileiramento, os
 * workers próprios drenam). Falha de um efeito não afeta os outros — log por
 * efeito, sem exceção cruzando o timer.
 */
function handleEffects(
  services: AppServices,
  deps: InternalSearchEffectsCollaborators,
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
  const { effects, accepted, nativeOnly, nativeKinds, rejected } = parseEffects(body.effects);
  if (nativeOnly > 0) {
    // Um warn por request, só com kind e contagem — payload não entra em log.
    // O motivo de existir: o `Deferred` do Rust (`tail_effects.rs`: sem escopo de
    // conta, `submit`/`offer` recusado) e o `Forward` do worker desligado
    // (`tail_effects.rs`) chegam os dois a este 202. Quem executa é o gateway
    // (worker nativo do Chupim para os kinds de trabalho, sink do warmer para
    // `rd_warmer`); se o lote veio por um desses dois caminhos, o aceite aqui
    // NÃO significa trabalho enfileirado.
    log.warn(
      `[internal] effects: nativeOnly=${nativeOnly} (${kindSummary(nativeKinds)}) aceitos sem execução local —`
      + ' o dono destes kinds é o gateway nativo (worker do Chupim / warmer RD); o Node só confirma o 202.'
      + ' Se chegaram aqui por `Deferred`/`Forward` do gateway (worker off,'
      + ' sem escopo de conta ou canal cheio), nada foi enfileirado: religue o dono nativo.',
    );
  }
  // Contexto do usuário para os timers: `capture()` cumpre o invariante do
  // AGENTS.md (timer pós-request precisa de capture + run); nas rotas internas
  // a store vem VAZIA, então o patch carrega o `encoded` do corpo — a origem
  // certa da preferência do usuário, nunca o `.env`.
  const captured = runtime.capture();
  const ctx = { ...(captured || {}), opts: target.opts, encoded: target.encoded };
  for (const effect of effects) {
    // setImmediate: a resposta sai primeiro; o `run` restaura a conta mesmo
    // longe da requisição (a drenagem da auditoria, por exemplo, agenda outra
    // drenagem dentro dela e herda o ALS daqui).
    setImmediate(() => {
      try {
        runtime.run(ctx, () => runEffect(deps, effect));
        log.debug(`[internal] effect ${effect.kind}: enfileirado`);
      } catch (err) {
        log.error(`[internal] effect ${effect.kind} falhou:`, err);
      }
    });
  }
  log.debug(`[internal] effects: accepted=${accepted} nativeOnly=${nativeOnly} rejected=${rejected}`);
  return res.status(202).json({ ok: true, accepted, rejected, nativeOnly });
}

/**
 * Registra as rotas de escrita/efeitos. Chamado por `registerInternalSearch`,
 * junto das rotas de leitura (montadas ANTES do overlay `/:userConfig`).
 */
export function registerInternalSearchEffects(
  router: Router,
  services: AppServices,
  overrides: Partial<InternalSearchEffectsCollaborators> = {},
): void {
  const deps: InternalSearchEffectsCollaborators = {
    harvestEnqueue: overrides.harvestEnqueue ?? enqueueNativeHarvest,
  };
  const json = express.json({ limit: '1mb' });

  router.post('/internal/search/effects', json, asyncRoute(async (req, res) => {
    if (rejectedByGuard(services, req, res)) return;
    handleEffects(services, deps, req, res);
  }));
}
