// Bloco `crawl` do /dashboard-status.json. Extraído de dashboard-status-blocks.ts
// pela catraca de 400 linhas. Cobre o caminho TS (crawler.status) e o caminho
// Rust (sidecar HTTP na porta do CRAWL_SIDECAR_PORT).
import type { AppServices } from './types.js';

/**
 * Bloco crawl: status do motor TS OU do sidecar Rust.
 *
 * Fase C4: quando `CRAWL_ENGINE=rust`, o status vem do sidecar via HTTP;
 * falha aberta (sidecar não acessível → { active: false, error }).
 */
export async function crawlBlock(
  services: AppServices,
  configSnapshot: unknown,
): Promise<Record<string, unknown>> {
  if (services.config.crawl.crawlEngine === 'rust') {
    const sidecarUrl = `http://127.0.0.1:${services.config.crawl.sidecarPort}/status`;
    try {
      const resp = await fetch(sidecarUrl, {
        signal: AbortSignal.timeout(3000),
        headers: {
          ...(services.config.jackett.testToken
            ? { 'X-Indexer-Test-Token': services.config.jackett.testToken }
            : {}),
        },
      });
      if (resp.ok) {
        const sidecarStatus = (await resp.json()) as Record<string, unknown>;
        return { ...sidecarStatus, engine: 'rust', config: configSnapshot };
      }
      return {
        active: false,
        engine: 'rust',
        error: `sidecar respondeu HTTP ${resp.status}`,
        config: configSnapshot,
      };
    } catch {
      return { active: false, engine: 'rust', error: 'sidecar não acessível', config: configSnapshot };
    }
  }
  return {
    ...services.crawler.status(),
    engine: 'ts',
    config: configSnapshot,
  };
}
