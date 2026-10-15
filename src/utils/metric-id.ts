// Id de métrica seguro para um valor de TERCEIRO (nome de indexer/adapter vindo
// de config ou do catálogo). É a fonte ÚNICA da normalização: o produtor do
// contador (`magnet-bank-fallback`) e o consumidor do painel
// (`dashboard-status-blocks`) precisam montar a MESMA chave
// `fallback.indexer.<id>` — duas cópias da regra divergiriam em silêncio e o
// indicador mostraria 0 para sempre.
export function safeMetricId(value: unknown): string {
  const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 40);
  return clean || 'unknown';
}

/**
 * Chave do contador de cobertura do banco vivo para um indexer. Produtor
 * (`magnet-bank-fallback`) e consumidor (bloco `indexers`) compartilham ESTA
 * função: um id que muda na normalização (`Bank Test/ID` → `bank_test_id`) cai
 * no mesmo balde dos dois lados.
 */
export function indexerFallbackMetricKey(indexerId: unknown): string {
  return `fallback.indexer.${safeMetricId(indexerId)}`;
}
