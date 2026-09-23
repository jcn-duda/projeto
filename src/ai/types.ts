/**
 * Tipos públicos do runtime TypeSafe (System One / Jev) — SHADOW-ONLY.
 *
 * O runtime NUNCA decide nada: o julgamento alimenta métrica de concordância
 * com o veredito determinístico (`looksPtBr`/`_br`) e um cache cru para não
 * repetir chamada. Nenhum consumidor de busca/ranking/limpeza importa os
 * resultados daqui — o teste de grafo (test/typesafe-shadow-graph.test.ts)
 * tranca isso por construção.
 */

/** Julgamento CRU cacheado (threshold é aplicado SÓ na comparação shadow). */
export interface JevAudioJudgment {
  /** noul 0..1 cru, do `answers.is_ptbr_dub.noul`. */
  n: number;
  /** Model que produziu o julgamento (o default versionado é `jev-1.13.0`; config pode apontar alias móvel). */
  m: string;
  /** Epoch ms da resposta. */
  at: number;
}

/** Resultado do enqueue síncrono (nunca lança, nunca bloqueia a resposta). */
export type EnqueueResult =
  | 'ok'
  | 'disabled'
  | 'paused'
  | 'dedup'
  | 'cache-hit'
  | 'queue-full'
  | 'cap'
  | 'day-cap'
  | 'cooldown';

/** Classe de falha do cliente — labels FECHOS, viram métrica fixa. */
export type AskErrorKind = 'auth' | 'rate' | 'timeout' | 'http' | 'shape' | 'network';

/** Resposta do cliente: noul validado em [0,1] + usage defensivo + eco do model. */
export interface AskOk {
  noul: number;
  usage?: { input: number; output: number };
  /**
   * ID versionado que de fato respondeu (§5 da referência Jev), ecoado pelo
   * serviço quando presente. O `model` de config PODE ser alias móvel
   * (`jev-latest`), então a auditoria do cache precisa do eco — nunca do
   * alias — para saber quem julgou (§11: "Alias em produção só com o ID
   * versionado registrado"; o overlay, aliás, se recusa a decidir com alias).
   */
  model?: string;
}
