// Contador de páginas por HORA CIVIL do motor de raspagem (teto horário).
// Extraído de `crawler.ts` para o motor ficar sob a catraca de linhas — a
// regra é pequena, mas é própria: balde por `floor(epoch/3600s)`, baldes velhos
// descartados na leitura (o Map nunca cresce além de dois buckets).
export interface HourCounter {
  /** Páginas anotadas na hora civil corrente. */
  current(): number;
  /** Anota UMA página na hora civil corrente. */
  note(): void;
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
    note() {
      const hour = hourOf();
      buckets.set(hour, (buckets.get(hour) || 0) + 1);
    },
    clear() {
      buckets.clear();
    },
  };
}
