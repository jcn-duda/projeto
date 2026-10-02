// Contador de páginas por HORA CIVIL do motor de raspagem (teto horário).
// Extraído de `crawler.ts` para o motor ficar sob a catraca de linhas — a
// regra é pequena, mas é própria: balde por `floor(epoch/3600s)`, baldes velhos
// descartados na leitura (o Map nunca cresce além de dois buckets).
export interface HourCounter {
  /** Páginas anotadas na hora civil corrente. */
  current(): number;
  /**
   * Anota N unidades na hora civil corrente. O default é 1 (uma página); a
   * Fase 7 cobra o custo REAL da página de série (cards + protetores) além
   * da página em si — uma página que custou 12 requisições não pode caber
   * no teto como se fosse uma.
   */
  note(amount?: number): void;
  /** Zera tudo (reset de teste). */
  clear(): void;
}

export function createHourCounter(): HourCounter {
  const buckets = new Map<number, number>();
  const hourOf = () => Math.floor(Date.now() / 3_600_000);
  return {
    current() {
      const hour = hourOf();
      for (const bucket of [...buckets.keys()]) {
        if (bucket < hour) buckets.delete(bucket);
      }
      return buckets.get(hour) || 0;
    },
    note(amount: number = 1) {
      const n = Math.max(1, Math.trunc(Number(amount) || 1));
      const hour = hourOf();
      buckets.set(hour, (buckets.get(hour) || 0) + n);
    },
    clear() {
      buckets.clear();
    },
  };
}

/**
 * Custo médio observado por página (requisições ÷ páginas desde o boot). É o
 * que o status usa para converter pendência de páginas em ETA de REQUISIÇÕES
 * (o teto horário é de requisições, não de páginas). Sem página medida, `avg`
 * é null — o painel mostra "—" em vez de inventar horas.
 */
export interface CostMeter {
  note(cost: number): void;
  avg(): number | null;
  reset(): void;
}

export function createCostMeter(): CostMeter {
  let total = 0;
  let pages = 0;
  return {
    note(cost: number) {
      total += Math.max(1, Math.trunc(Number(cost) || 1));
      pages += 1;
    },
    avg() {
      return pages > 0 ? Math.round((total / pages) * 100) / 100 : null;
    },
    reset() {
      total = 0;
      pages = 0;
    },
  };
}
