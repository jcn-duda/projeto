// Coalescing da colheita em voo (Fase 4, C8).
//
// Sem isto, uma sonda dirigida que chega enquanto o colhedor JÁ colhe a mesma
// obra enfileirava uma SEGUNDA entrada — a mesma obra era raspada duas vezes
// (uma regular, outra dirigida) e a fila ganhava trabalho duplicado. Aqui a
// intenção da sonda é anexada OR-aderente à obra em voo; quando a colheita
// termina, o resultado COMPLETO finaliza o estado (`found`/`empty`/`failed`).
//
// Módulo pequeno e SEM dependências para não criar ciclo: `br-probe` e
// `harvester` importam daqui, e este não importa de ninguém. Só uma obra fica
// em voo por vez (o tick do colhedor é serial por contrato), então um único
// slot basta e a identidade é comparada em cada toque.
let current: { identity: string; probe: boolean } | null = null;

/** Marca o início da colheita de uma obra. */
export function begin(identity: string): void {
  current = { identity: String(identity || ''), probe: false };
}

/** Encerra a colheita da obra, descartando a intenção anexada. */
export function end(identity: string): void {
  if (current && current.identity === String(identity || '')) current = null;
}

/** A obra está sendo colhida AGORA? */
export function isInflight(identity: string): boolean {
  return Boolean(current && current.identity === String(identity || ''));
}

/**
 * Anexa a intenção de sonda à obra em voo. Devolve `true` quando a obra é a
 * que está em execução — o chamador NÃO deve enfileirar uma segunda entrada.
 */
export function attachProbe(identity: string): boolean {
  if (!current || current.identity !== String(identity || '')) return false;
  current.probe = true;
  return true;
}

/** Há intenção de sonda anexada a esta obra em voo? (não limpa) */
export function hasProbeIntent(identity: string): boolean {
  return Boolean(current && current.identity === String(identity || '') && current.probe);
}

/** Limpa o slot volátil — simula restart nos testes. */
export function resetHarvestInflightForTest(): void {
  current = null;
}
