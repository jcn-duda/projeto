// Dublê da admin 8711 para as ações do banco vivo no dashboard
// (`magnet-bank-summary` / `magnet-bank-search`): a ação é fachada da ponte —
// o conteúdo do acervo é testado no Rust (`magnet_bank_read_tests.rs`); aqui
// vale o eco fiel do shape e a credencial da streamStore viajando.
import config from '../../src/config.js';
import { stubFetch, type StubFetchHandler } from './stub.js';

export const MAGNET_ADMIN_BASE = 'http://127.0.0.1:8711';

/**
 * Roda `fn` com o `streamStore` apontando para a admin dublê (mesma precedência
 * do painel: token destrutivo) e restaura tudo no fim — stub incluído.
 */
export async function withMagnetAdmin<T>(
  token: string,
  handler: StubFetchHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const savedStream = { url: config.streamStore.url, token: config.streamStore.token };
  config.streamStore.url = MAGNET_ADMIN_BASE;
  config.streamStore.token = token;
  const stub = stubFetch(handler);
  try {
    return await fn();
  } finally {
    stub.restore();
    config.streamStore.url = savedStream.url;
    config.streamStore.token = savedStream.token;
  }
}

/** Panorama que a admin devolve com o banco em memória (shape do painel). */
export const MAGNET_ADMIN_STATUS = {
  ok: true, enabled: true, engine: 'sql', magnets: 2, sources: 2, works: 2,
  lastSeen: 1234, memoryMax: null, memoryEvictions: 0, queue: 0, queueMax: 500,
  byIndexer: [{ indexer: 'bludv', hashes: 1, sources: 1, lastSeen: 1234 }],
};
