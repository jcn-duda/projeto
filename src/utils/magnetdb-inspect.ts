// Enumeração do banco de magnets (`mag:v1`) para as ações do painel (Fase 3).
// Módulo separado do magnetdb.ts de propósito: aquele arquivo está no teto de
// 400 linhas e a responsabilidade aqui é outra — leitura/limpeza OPERACIONAL
// (diagnóstico do operador), não o histórico que alimenta a busca.
//
// DONO NATIVO (T2-L5b): o `mag` é do núcleo Rust e o Node não o carrega no L1 —
// as varreduras do cache local nunca o veriam. Toda a enumeração vem da ponte
// (`magnetState`): o núcleo filtra por adapter/side/hash, conta o total
// casado e corta no `limit`, então o painel não atravessa dezenas de milhares de
// chaves para mostrar 50. `limit` 0 = SEM LIMITE (só quem precisa do namespace
// inteiro passa zero).
//
// Segurança de payload: a chave mag carrega o DIGEST da conta
// (`accountScope(apiKey)`) entre adapterId e hash. O núcleo devolve só
// adapter/side/hash — nenhum token de conta atravessa esta camada, e o hash
// devolvido é o do CONTEÚDO (40-hex), nunca credencial.
import * as magnetdb from './magnetdb.js';
import { magnetState } from './debrid-state-native.js';
import { MAG_SIDES, type MagSide } from './magnetdb-counts.js';
import * as magnetBank from './magnet-bank.js';

export { MAG_SIDES };
export type { MagSide };

export type MagFilters = { adapterId?: string; side?: MagSide; hash?: string };

export type MagEntryView = {
  adapterId: string;
  side: MagSide;
  hash: string;
  ttlRemainingSeconds: number | null;
  /** URI de magnet do banco permanente (`magnet-bank`). Null se ausente. */
  magnet: string | null;
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

/**
 * Lista entradas do banco (nativas) até `limit` itens, com o total casado para
 * o painel paginar. Leitura SEM efeito: o núcleo não promove LRU nem conta
 * cache.hit/miss — diagnóstico não pode reordenar o cache de produção nem
 * inflar a medição de ⚡.
 */
function inspect(filters: MagFilters, limit: number): MagInspectResult {
  const page = magnetState().entries(
    filters.adapterId ?? null,
    filters.side ?? null,
    filters.hash ?? null,
    limit,
    Date.now(),
  );
  const items: MagEntryView[] = page.items.map((item) => ({
    adapterId: item.adapter,
    side: item.side,
    hash: item.hash,
    // O restante já vem calculado do núcleo; linha vencida não é devolvida.
    ttlRemainingSeconds: item.ttlRemainingSeconds,
    magnet: magnetBank.lookup(item.hash)?.uri ?? null,
  }));
  return { items, matched: page.matched, truncated: page.truncated };
}

/**
 * Apaga registros `bad` casados pelos filtros, até `limit` por passagem.
 * Idempotente: a segunda passada devolve cleared 0 porque o par já saiu.
 * O `forgetBadOf` do magnetdb só apaga o par no núcleo — os contadores
 * duráveis por adapter são reconciliados fora daqui.
 * `alive`/`lie` do mesmo hash NÃO são tocados (mesma semântica do forgetBad).
 *
 * MUDANÇA DE UNIDADE (T2-L5b): o núcleo apaga o `bad` do PAR (adapter, hash) em
 * TODAS as contas de uma vez; antes era uma chave por conta. `cleared` conta
 * pares, não chaves — as demais contas do mesmo par saem junto, e é a segunda
 * passagem que fecha a conta exata (o `remaining` é só a diferença da página).
 */
function clearBads(filters: MagFilters, limit: number): { cleared: number; remaining: number } {
  const page = magnetState().entries(filters.adapterId ?? null, 'bad', filters.hash ?? null, limit, Date.now());
  let cleared = 0;
  for (const item of page.items) {
    if (magnetdb.forgetBadOf(item.adapter, item.hash)) cleared += 1;
  }
  return { cleared, remaining: page.matched - page.items.length };
}

/** Agregado por adapter × side numa única passada nativa — sem hash nenhum no payload. */
function summary(): MagSummary {
  const totals = { alive: 0, bad: 0, lie: 0 };
  const byAdapter: Record<string, { alive: number; bad: number; lie: number }> = Object.create(null);
  let entries = 0;
  for (const count of magnetState().summary(Date.now())) {
    entries += count.count;
    totals[count.side] += count.count;
    const bucket = byAdapter[count.adapter] || (byAdapter[count.adapter] = { alive: 0, bad: 0, lie: 0 });
    bucket[count.side] += count.count;
  }
  return { entries, totals, byAdapter };
}

export { inspect as magInspect, clearBads as magClearBads, summary as magSummary };
