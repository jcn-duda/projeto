// Resumo por OBRA do teto do Chupim (Fase 7 do Chupim 2.0) — leitura quiet.
//
// O teto por obra (F2, `autofetch-obra.ts`) guarda um registro persistido por
// digest de obra, com os pools aceitos (`br`/`any`/`seeds`). O painel não tinha
// como enxergar esse estado: só o `obraStatus()` volátil (works/reserved). Este
// módulo varre o namespace `autofetch:v3:o:` e resume, por obra, o que o teto
// tem — sem identificar a obra: digest de 12 chars, contagem por pool, a prova
// durável de BR-ready (Fase 6) e a idade da entrada mais recente.
//
// Contrato de leitura:
// - QUIET: `keysMatching` (L1) + `peek`, como o painel de magnets. NÃO usa o
//   `readRecord` interno do autofetch-obra porque ele passa por `cache.get`,
//   que promove LRU e conta `cache.hit` — um diagnóstico não pode reordenar o
//   cache nem inflar o hit-rate que ele mesmo mostra.
// - Ausência de dado nunca autoriza afirmação: só entra obra com ao menos uma
//   entrada dentro da janela (`autoFetchTtl`); o resto é ruído expirado.
// - Payload limitado às N mais recentes (`OBRA_SUMMARY_MAX`) para o teto de
//   resposta do `/dashboard-status.json` não crescer com o acervo.
import * as cache from '../utils/cache.js';
import autofetchLive from '../utils/autofetch-live.js';
import { OBRA_PREFIX } from './autofetch-obra.js';
import { hasBrReady } from './autofetch-evict.js';

/** Quantas obras o status devolve (as mais recentes por entrada). */
export const OBRA_SUMMARY_MAX = 12;

export interface ObraSummary {
  /** 12 primeiros chars do sha256 da identidade — NUNCA imdbId/conta/chave. */
  digest: string;
  /** Aceites persistidos por pool (reserva viva não-commitada não entra). */
  pools: { br: number; any: number; seeds: number };
  /** Prova durável de BR ready da obra (Fase 6). */
  brReady: boolean;
  /** Idade (ms) da entrada mais recente do registro. */
  ageMs: number;
}

/** Parse quiet de `{ entries: [...] }`; formato estranho conta como vazio. */
function peekEntries(key: string): Array<Record<string, unknown>> {
  const raw = cache.peek(key) as { entries?: unknown } | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return [];
  return raw.entries.filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
}

/**
 * Obras ativas no teto, mais recentes primeiro. O(namespace `o:`) sobre o L1 —
 * mesma ordem da varredura do painel de magnets, só no status, nunca na busca.
 */
export function obraSummaries(limit = OBRA_SUMMARY_MAX): ObraSummary[] {
  const now = Date.now();
  const span = Math.max(0, Number(autofetchLive.effective().autoFetchTtl) || 0) * 1000;
  const out: ObraSummary[] = [];
  for (const key of cache.keysMatching(OBRA_PREFIX)) {
    const digest = key.slice(OBRA_PREFIX.length);
    if (!digest) continue;
    const entries = peekEntries(key).filter((e) => {
      const at = Number(e.acceptedAt);
      return Number.isFinite(at) && at > 0 && (span <= 0 || at > now - span);
    });
    if (entries.length === 0) continue;
    const pools = { br: 0, any: 0, seeds: 0 };
    let newest = 0;
    for (const entry of entries) {
      const at = Number(entry.acceptedAt);
      if (at > newest) newest = at;
      const pool = String(entry.pool || '');
      if (pool === 'br' || pool === 'any' || pool === 'seeds') pools[pool] += 1;
    }
    out.push({ digest: digest.slice(0, 12), pools, brReady: hasBrReady(digest), ageMs: Math.max(0, now - newest) });
  }
  out.sort((a, b) => a.ageMs - b.ageMs);
  const max = Math.max(1, Math.trunc(Number(limit) || OBRA_SUMMARY_MAX));
  return out.slice(0, max);
}
