// Bloco `crawl` do /dashboard-status.json. Extraído de dashboard-status-blocks.ts
// pela catraca de 400 linhas: o `crawler.status()` (cards do `crawl.db`) com a
// foto do sidecar Rust (HTTP na porta do CRAWL_SIDECAR_PORT) ao lado.
import type { AppServices } from './types.js';

/** Foto do sidecar Rust (`GET /status`); `error` quando não respondeu. */
async function sidecarStatus(services: AppServices): Promise<Record<string, unknown>> {
  const url = `http://127.0.0.1:${services.config.crawl.sidecarPort}/status`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(services.config.crawl.sidecarStatusTimeoutMs),
      headers: services.config.jackett.testToken
        ? { 'X-Indexer-Test-Token': services.config.jackett.testToken }
        : {},
    });
    if (resp.ok) return (await resp.json()) as Record<string, unknown>;
    return { active: false, error: `sidecar respondeu HTTP ${resp.status}` };
  } catch {
    return { active: false, error: 'sidecar não acessível' };
  }
}

/**
 * Bloco crawl. O painel lê SEMPRE o formato do `crawler.status()` (cards,
 * catálogo, contadores do `crawl.db`, config ao vivo) — é o mesmo banco que o
 * sidecar Rust escreve. A foto do sidecar vai junto em `sidecar`; devolver só ela deixava o painel "DESLIGADO" e "Nenhum site em
 * CRAWL_SITES" com o raspador rodando (formato diferente: `site_id`, sem
 * `enabled`). Falha do sidecar é aberta: o resto do bloco segue.
 */
export async function crawlBlock(
  services: AppServices,
  configSnapshot: unknown,
): Promise<Record<string, unknown>> {
  const base = { ...services.crawler.status(), config: configSnapshot };
  const sidecar = await sidecarStatus(services);
  return {
    ...base,
    engine: 'rust',
    sidecar,
    ...(typeof sidecar.error === 'string' ? { error: sidecar.error } : {}),
  };
}
