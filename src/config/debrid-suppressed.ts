import { num } from './helpers.js';

// Bloco da revalidação de represados (item 1b), extraído pela catraca de 400
// linhas — o mesmo padrão de `debrid-evict.ts`/`debrid-reconcile.ts`. As chaves
// são espalhadas no compositor com `...suppressedRevalidate()`; nenhum default
// muda.
export const suppressedRevalidate = () => ({
  // DEBRID_SUPPRESSED_REVALIDATE (default false): automação DESTRUTIVA em conta
  // BYO — revalida em fundo a fila de represados com a chave da instalação e
  // apaga pelo gate `deleteMagnets` o que o status AUTORITATIVO declarar
  // terminal pelo TEXTO. Segue a convenção do repo (RECONCILE/EVICT_FALLBACK
  // nascem OFF): ligar aqui é a autorização explícita para delete por hash sem
  // o freio `DEBRID_REMOVE_BY_ID`, limitada ao escopo da fila (não varre a
  // conta inteira como o `sweepDead`). `false` = zero rede no módulo.
  suppressedRevalidate: String(process.env.DEBRID_SUPPRESSED_REVALIDATE || 'false') === 'true',
  // Idade mínima do magnet na conta (uploadDate) antes de o terminal ser
  // elegível à remoção pela revalidação — mesmo piso do `sweepDead`. Sem data
  // legível NÃO remove (ausência nunca autoriza).
  suppressedRevalidateMinAgeMs: Math.max(0, num(process.env.DEBRID_SUPPRESSED_REVALIDATE_MIN_AGE_MS, 1_800_000)),
});
