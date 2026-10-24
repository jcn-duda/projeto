import { num } from './helpers.js';

// Bloco da evicção dirigida dos fallbacks da mesma obra (Fase 6 do Chupim 2.0),
// extraído de `src/config/debrid.ts` para a catraca de 400 linhas — o mesmo
// padrão de `debrid-reconcile.ts` e `debrid-autofetch-seeds.ts`. As chaves são
// espalhadas no compositor com `...evictFallback()`; nenhum default muda.
export const evictFallback = () => ({
  // Quando um BR dublado aceito pelo Chupim fica ready, remove da conta
  // AllDebrid os fallbacks `any`/`seeds` da MESMA obra cuja posse (adsub) e
  // identidade (marker novo) estejam provadas. Destrutiva: nasce OFF e o
  // rollback é uma linha; OFF = zero rede, zero leitura de status e zero
  // delete. Só o AllDebrid implementa; serviço sem o método é no-op.
  autoFetchEvictFallback: String(process.env.DEBRID_AUTO_FETCH_EVICT_FALLBACK || 'false') === 'true',
  // Idade mínima do fallback na conta (contada do acceptedAt do registro F2)
  // antes de ser elegível. Sem prova de idade, NÃO remove — fail-safe fechado.
  autoFetchEvictFallbackMinAgeMs: Math.max(0, num(process.env.DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS, 1_800_000)),
  // Teto total da conta no debrid (default 1000, teto real AllDebrid).
  accountCap: Number(process.env.DEBRID_ACCOUNT_CAP || 1000),
});
