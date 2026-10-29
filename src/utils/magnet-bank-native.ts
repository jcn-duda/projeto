// Ponte do Node com o IMPORT do banco de magnets (`data/magnets.db`).
//
// Desde a migração o gateway Rust é o único que GRAVA no banco: o import do
// painel (aba Magnets) manda o arquivo já descompactado para o temporário e
// pede à admin do gateway que o mescle. Se o Node gravasse também, dois
// processos disputariam o mesmo SQLite e a mescla deixaria de ser idempotente
// ao lado de uma escrita de captura. O Node só transporta: spool, pedido e
// resposta.
//
// Mesmo padrão de `streams-store-native.ts`: base e token vêm de
// `config.streamStore` (`STREAM_STORE_ADMIN_URL`, token destrutivo), e o
// header é o `x-indexer-test-token` da superfície admin. A mescla é longa
// (um acervo de ~1 milhão de linhas leva minutos), por isso o prazo é o
// `importTimeoutMs` e NÃO o `timeoutMs` curto das outras rotas.
//
// Nunca lança: `null` quer dizer "a admin não respondeu" (sem token, rede
// fora ou prazo vencido) e quem chama devolve 503 em vez de fingir sucesso.
import config from '../config.js';
import * as log from './logger.js';

/** `null` = a admin não respondeu; senão o status HTTP e o corpo devolvidos. */
export type NativeImportResult = { status: number; body: Record<string, unknown> } | null;

/**
 * Credencial DESTRUTIVA — a mesma precedência de `config/stream-store.ts`
 * (`STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`). O import grava no
 * acervo, então o token de diagnóstico (`JACKETT_TEST_TOKEN`) não serve: o
 * gateway o recusaria com 403 `magnet_bank_token_insufficient`.
 */
function destructiveToken(): string {
  return config.streamStore.token || '';
}

function baseUrl(): string {
  return String(config.streamStore.url || '').replace(/\/+$/, '');
}

/**
 * Pede ao gateway que mescle o NDJSON descompactado em `spoolPath`. O caminho
 * tem que ser absoluto e ter o nome `adom-magnets-import-<algo>.ndjson`: o
 * gateway recusa qualquer outro arquivo (`invalid_path`).
 */
export async function importNativeBank(spoolPath: string): Promise<NativeImportResult> {
  const token = destructiveToken();
  // Sem credencial destrutiva não há o que pedir: o gateway responderia 403.
  // Não abrimos conexão nenhuma nesse caso.
  if (!token) return null;
  try {
    const res = await fetch(`${baseUrl()}/magnet-bank/import`, {
      method: 'POST',
      headers: {
        'x-indexer-test-token': token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ path: spoolPath, confirm: true }),
      signal: AbortSignal.timeout(Math.max(1000, config.magnetBank.importTimeoutMs)),
    });
    let body: Record<string, unknown> = { ok: false, error: `HTTP ${res.status} sem corpo JSON` };
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // corpo não-JSON: o status e o `error` padrão acima já dizem o essencial
    }
    return { status: res.status || 0, body };
  } catch (err: unknown) {
    log.warn(`[magnetbank] admin não respondeu ao import: ${log.errorMessage(err)}`);
    return null;
  }
}
