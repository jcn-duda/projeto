// Enumeração do L1 do banco de magnets para as ações do painel (Fase 3).
// Módulo separado do magnetdb.ts de propósito: aquele arquivo está no teto de
// 400 linhas e a responsabilidade aqui é outra — leitura/limpeza OPERACIONAL
// (diagnóstico do operador), não o histórico que alimenta a busca.
//
// Só L1: `keysMatching` + `peek`/`peekRemaining`/`forget` — nenhuma query
// síncrona no SQLite. O L2 acompanha pelas mesmas operações (o forgetMany
// interno do cache mantém L1, fila pendente e disco coerentes), sem scan.
//
// Segurança de payload: a chave mag carrega o DIGEST da conta
// (`accountScope(apiKey)`) entre adapterId e hash. O parse descarta esse
// token na origem — nenhuma função daqui o expõe, e o hash devolvido é o do
// CONTEÚDO (40-hex), nunca credencial.
import * as cache from './cache.js';
import * as magnetdb from './magnetdb.js';
import { prefix } from './cache-keys.js';
import { MAG_SIDES, parseMagKey, type MagSide, type ParsedMagKey } from './magnetdb-counts.js';

export { MAG_SIDES };
export type { MagSide };

export type MagFilters = { adapterId?: string; side?: MagSide; hash?: string };

export type MagEntryView = {
  adapterId: string;
  side: MagSide;
  hash: string;
  ttlRemainingSeconds: number | null;
};

export type MagInspectResult = {
  items: MagEntryView[];
  matched: number;
  truncated: boolean;
};

export type MagSummary = {
  entries: number;
  totals: { alive: number; bad: number; lie: number };
  byAdapter: Record<string, { alive: number; bad: number; lie: number }>;
};

// O parse da chave (e o descarte do digest da conta) mora em magnetdb-counts:
// a reconstrução das contagens precisa do mesmo formato, e duas cópias
// divergiriam em silêncio na próxima versão do namespace.
function matches(filters: MagFilters, entry: ParsedMagKey): boolean {
  if (filters.adapterId && entry.adapterId !== filters.adapterId) return false;
  if (filters.side && entry.side !== filters.side) return false;
  if (filters.hash && entry.hash !== filters.hash) return false;
  return true;
}

/**
 * Lista entradas do banco (L1) até `limit` itens, com o total casado para o
 * painel paginar. Leitura SEM efeito: `keysMatching` + `peekRemaining` não
 * promovem LRU nem contam cache.hit/miss — diagnóstico não pode reordenar o
 * cache de produção nem inflar a medição de ⚡.
 */
function inspect(filters: MagFilters, limit: number): MagInspectResult {
  const base = prefix('mag');
  const items: MagEntryView[] = [];
  let matched = 0;
  for (const key of cache.keysMatching(base)) {
    const parsed = parseMagKey(key, base);
    if (!parsed || !matches(filters, parsed)) continue;
    matched += 1;
    if (items.length >= limit) continue;
    items.push({ ...parsed, ttlRemainingSeconds: cache.peekRemaining(key) });
  }
  return { items, matched, truncated: matched > items.length };
}

/**
 * Apaga registros `bad` casados pelos filtros, até `limit` por passagem.
 * Idempotente: a segunda passada devolve cleared 0 porque a chave já saiu.
 * A contagem durável por adapter fica coerente sozinha — o hook `onForget` do
 * magnetdb decrementa e reagenda o snapshot persistido em cada forget.
 * `alive`/`lie` do mesmo hash NÃO são tocados (mesma semântica do forgetBad).
 */
function clearBads(filters: MagFilters, limit: number): { cleared: number; remaining: number } {
  // Prefixo COMPLETO (mag:v1:) e não mag:v1:bad:: o parse espera os 4 tokens
  // após a base; incluir o lado no prefixo deixaria 3 partes e a chave inteira
  // seria descartada como malformada. O filtro `side: 'bad'` do chamador decide.
  const base = prefix('mag');
  let cleared = 0;
  let remaining = 0;
  for (const key of cache.keysMatching(base)) {
    const parsed = parseMagKey(key, base);
    if (!parsed || parsed.side !== 'bad' || !matches(filters, parsed)) continue;
    if (cleared >= limit) {
      remaining += 1;
      continue;
    }
    if (magnetdb.forgetBadKey(key)) cleared += 1;
  }
  return { cleared, remaining };
}

/** Agregado por adapter × side numa única passada — sem hash nenhum no payload. */
function summary(): MagSummary {
  const base = prefix('mag');
  const totals = { alive: 0, bad: 0, lie: 0 };
  const byAdapter: Record<string, { alive: number; bad: number; lie: number }> = Object.create(null);
  let entries = 0;
  for (const key of cache.keysMatching(base)) {
    const parsed = parseMagKey(key, base);
    if (!parsed) continue;
    entries += 1;
    totals[parsed.side] += 1;
    const bucket = byAdapter[parsed.adapterId] || (byAdapter[parsed.adapterId] = { alive: 0, bad: 0, lie: 0 });
    bucket[parsed.side] += 1;
  }
  return { entries, totals, byAdapter };
}

export { inspect as magInspect, clearBads as magClearBads, summary as magSummary };
