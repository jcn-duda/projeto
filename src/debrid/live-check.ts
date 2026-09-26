// P5 Fatia B — live read-only por adaptador (TorBox/Premiumize APENAS).
//
// O /stream-trace.json com trace explica "na hora da build"; o recompute
// explica com material local; o LIVE pergunta AO SERVIÇO se o hash ainda está
// em cache — mas só onde perguntar é LEITURA de verdade:
//
//   TorBox/Premiumize — checkCached cru é GET puro (lote instantâneo);
//   AllDebrid         — checar É upload e detona limpeza: HARD-BLOCK;
//   Real-Debrid       — o oráculo escreve ledger/rdt e pode enviar a chave a
//                       terceiro; a leitura crua é só o ledger (que o recompute
//                       já lê quiet): recusado;
//   Debrid-Link       — sem cacheCheck: recusado.
//
// Regra dura (auditoria adversarial): o método CRU do adapter de BY_ID, NUNCA
// `debrid.checkCached()` (a camada orquestrada grava davail, magnetdb,
// métricas debrid.check.* e notify). Este módulo NÃO importa cache-check nem
// rd-ledger: nada aqui escreve em lugar nenhum.
import * as registry from './registry.js';

export type LiveVerdict = 'hit' | 'miss' | 'skipped';

export interface LiveResult {
  allowed: boolean;
  reason: string | null; // ad-hard-blocked | rd-live-refused | no-cachecheck | knob-off | ok
  service: string | null;
  results: Array<{ id: string; name: string; verdict: LiveVerdict }>;
}

const ALLOWED_RAW = new Set(['torbox', 'premiumize']);

/** Serviços que NUNCA participam do live — defesa em profundidade: mesmo que
 * a allowlist cresça por engano, estes não entram (a AllDebrid checar É
 * upload; o RD escreve ledger/oráculo; DL não tem cacheCheck). */
const NEVER_LIVE = new Set(['alldebrid', 'realdebrid', 'debridlink']);

/**
 * Sonda de CAPACIDADE (síncrona, sem rede): o endpoint responde `live.allowed`
 * em toda consulta para o painel decidir se renderiza o botão. Regra dupla —
 * allowlist fechada + denylist estrutural + knob ligado + conta efetiva.
 */
export function liveCapability(
  serviceId: string | null | undefined,
  apiKey: string | null | undefined,
  liveEnabled: boolean,
): { allowed: boolean; reason: string | null; service: string | null } {
  const service = serviceId || null;
  if (!service || !apiKey) return { allowed: false, reason: 'no-account', service };
  if (NEVER_LIVE.has(service)) {
    const reason = service === 'alldebrid'
      ? 'ad-hard-blocked'
      : service === 'realdebrid'
        ? 'rd-live-refused'
        : 'no-cachecheck';
    return { allowed: false, reason, service };
  }
  if (!ALLOWED_RAW.has(service)) return { allowed: false, reason: 'no-cachecheck', service };
  if (!liveEnabled) return { allowed: false, reason: 'knob-off', service };
  return { allowed: true, reason: 'ok', service };
}

/**
 * Roda o live contra a conta EFETIVA desta instalação (mesma credencial de
 * uma busca real), com timeout e teto de hashes. `items` entram com hash
 * INTERNO (aqui dentro) e saem só com id/nome/veredito — o hash some.
 */
export async function liveCheck(
  serviceId: string,
  apiKey: string,
  items: Array<{ id: string; name: string; hash: string }>,
  { timeoutMs, maxHashes }: { timeoutMs: number; maxHashes: number },
): Promise<LiveResult> {
  if (NEVER_LIVE.has(serviceId)) {
    const reason = serviceId === 'alldebrid'
      ? 'ad-hard-blocked'
      : serviceId === 'realdebrid'
        ? 'rd-live-refused'
        : 'no-cachecheck';
    return { allowed: false, reason, service: serviceId, results: [] };
  }
  if (!ALLOWED_RAW.has(serviceId)) {
    return { allowed: false, reason: 'no-cachecheck', service: serviceId, results: [] };
  }
  const adapter = registry.BY_ID.get(serviceId);
  if (!adapter || typeof adapter.checkCached !== 'function') {
    return { allowed: false, reason: 'no-cachecheck', service: serviceId, results: [] };
  }
  const batch = items.slice(0, maxHashes);
  const hashes = batch.map((i) => i.hash);
  if (hashes.length === 0) {
    return { allowed: true, reason: 'ok', service: serviceId, results: [] };
  }
  try {
    // Método CRU do adaptador: GET de lote instantâneo, sem camada orquestrada.
    const raw = await adapter.checkCached(apiKey, hashes, { timeoutMs });
    // Contrato do adapter: Set de hashes prontos, ARRAY (retorno do batched)
    // ou {cached: Set, complete?}.
    const rawCached = raw instanceof Set
      ? raw
      : Array.isArray(raw)
        ? new Set(raw)
        : (raw as { cached?: Set<string> }).cached;
    const cached = new Set(
      [...((rawCached as Set<string> | undefined) ?? new Set())].map((h) => String(h).toLowerCase()),
    );
    const results = batch.map((item) => ({
      id: item.id,
      name: item.name,
      verdict: cached.has(String(item.hash).toLowerCase()) ? ('hit' as const) : ('miss' as const),
    }));
    return { allowed: true, reason: 'ok', service: serviceId, results };
  } catch (err) {
    // Rate/quota/timeout são locais: o live não pode insinuar estado de conta
    // que leitura avulsa não provou — vira `skipped`, nunca `unusable`.
    const results = batch.map((item) => ({ id: item.id, name: item.name, verdict: 'skipped' as const }));
    return { allowed: true, reason: 'ok', service: serviceId, results };
  }
}
