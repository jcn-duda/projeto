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
//
// As LEITURAS do painel (`bankStatusNative`/`bankSearchNative`) seguem o mesmo
// contrato, com a diferença de prazo que a operação pede: status e busca são
// leitura rápida (prazo curto `streamStore.timeoutMs`), não a mescla longa do
// import — e a falha sai em debug, porque o painel faz poll e warn repetido
// viraria ruído.
import config from '../config.js';
import * as log from './logger.js';
import { requireCore } from './rust-core.js';

/** `null` = a admin não respondeu; senão o status HTTP e o corpo devolvidos. */
export type NativeImportResult = { status: number; body: Record<string, unknown> } | null;

/** Mesmo contrato do import, para as leituras de painel. */
export type NativeBankResult = { status: number; body: Record<string, unknown> } | null;

/** Dublê de fetch e prazo próprios de teste. */
export type NativeReadOptions = {
  fetchImpl?: typeof fetch;
  /** Sobrepõe o prazo curto da admin (ms). */
  timeoutMs?: number;
};

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

/**
 * GET de leitura na admin (`/magnet-bank/status` e `/magnet-bank/search`):
 * mesmas guardas do import — credencial DESTRUTIVA no `x-indexer-test-token`,
 * sem ela não há conexão — e mesmo contrato: qualquer falha (rede fora, prazo
 * vencido, resposta ilegível) devolve `null` sem lançar. O prazo é o
 * `streamStore.timeoutMs` curto (leitura de painel), não o `importTimeoutMs`.
 */
async function adminRead(path: string, options: NativeReadOptions = {}): Promise<NativeBankResult> {
  const token = destructiveToken();
  if (!token) return null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? (Number(config.streamStore.timeoutMs) || 2000);
  try {
    const res = await fetchImpl(`${baseUrl()}${path}`, {
      headers: {
        'x-indexer-test-token': token,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    let body: Record<string, unknown> = { ok: false, error: `HTTP ${res.status} sem corpo JSON` };
    try {
      const parsed = (await res.json()) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // corpo não-JSON: o status e o `error` padrão acima já dizem o essencial
    }
    return { status: res.status || 0, body };
  } catch (err: unknown) {
    log.debug(`[magnetbank] admin não respondeu a ${path}: ${log.errorMessage(err)}`);
    return null;
  }
}

/**
 * Panorama do banco vivo pela admin do gateway (`GET /magnet-bank/status`):
 * quem abre o `data/magnets.db` é o gateway; o Node só repassa o JSON.
 */
export async function bankStatusNative(options: NativeReadOptions = {}): Promise<NativeBankResult> {
  return adminRead('/magnet-bank/status', options);
}

/**
 * Busca read-only no banco vivo pela admin (`GET /magnet-bank/search`). A
 * validação da query e o teto de itens são régua do gateway: aqui só vai o
 * `q` cru (encodado) e o `limit` já resolvido por quem chama.
 */
export async function bankSearchNative(q: string, limit?: number, options: NativeReadOptions = {}): Promise<NativeBankResult> {
  const params = new URLSearchParams({ q });
  if (limit != null) params.set('limit', String(Math.trunc(limit)));
  return adminRead(`/magnet-bank/search?${params.toString()}`, options);
}

// --- Leituras do banco vivo direto no núcleo (ponte read-only) -------------
//
// Fase 2 do corte (docs/superpowers/plans/2026-11-01-banco-vivo-corte.md):
// quem abre o `data/magnets.db` no caminho do play/índice é o núcleo
// (`bank_read.rs`); o TS só transporta o caminho de `config.magnetBank`.
// Síncrono e fail-open SEMPRE: `null`/`[]` significa "banco desligado, núcleo
// sem a leitura ou SQLite falhou" e o consumidor cai no fallback de hoje — a
// leitura do acervo nunca derruba o play. O kill-switch vem ANTES do require:
// com o banco desligado nem o arquivo é criado.

/** Superfície das leituras do banco no núcleo (`bank_read.rs`). */
export type BankReadCore = {
  /** URI gravada do magnet por hash; `null` = hash fora do banco. */
  bankLookupUri(dbPath: string, hash: string, nowMs: number): string | null;
  /** Linhas do acervo por hash, no shape plano que o `record` do índice consome. */
  bankRowsForMediaSource(
    dbPath: string,
    hashes: string[],
  ): Array<{ hash: string; uri: string; title: string }>;
};

/** Núcleo com as leituras do banco, ou null quando não deve tocá-lo. */
function bankReadCore(): BankReadCore | null {
  // Kill-switch (MAGNET_BANK=false): o banco nem existe no TS — abrir o SQLite
  // aqui criaria um arquivo vazio que o gateway desligado não usa.
  if (!config.magnetBank?.enabled) return null;
  try {
    const core = requireCore();
    return core.bankLookupUri && core.bankRowsForMediaSource
      ? (core as unknown as BankReadCore)
      : null;
  } catch (err: unknown) {
    log.debug(`[magnetbank] núcleo sem a leitura do banco: ${log.errorMessage(err)}`);
    return null;
  }
}

/**
 * URI do banco vivo por hash (o `lookup` do TS, consumido pelo play e pelo
 * inventário do painel). Hash fora do banco, banco desligado ou falha: `null`.
 */
export function bankLookupUriNative(hash: string): string | null {
  const core = bankReadCore();
  if (!core) return null;
  try {
    // Mesma régua do `normHash` do TS (toLowerCase, sem trim); o store
    // normaliza de novo do lado de lá. O relógio é reservado no Rust.
    return core.bankLookupUri(config.magnetBank.dbPath, String(hash || '').toLowerCase(), Date.now()) ?? null;
  } catch (err: unknown) {
    log.debug(`[magnetbank] leitura nativa do banco falhou: ${log.errorMessage(err)}`);
    return null;
  }
}

/**
 * Linhas do acervo para a fonte de mídia do índice (o lote de
 * `bankRowsForMediaSource`): [] com lista vazia, banco desligado ou falha.
 */
export function bankRowsForMediaSourceNative(
  hashes: readonly string[],
): Array<{ hash: string; uri: string; title: string }> {
  const core = bankReadCore();
  if (!core || hashes.length === 0) return [];
  try {
    const rows = core.bankRowsForMediaSource(config.magnetBank.dbPath, [...hashes]);
    return Array.isArray(rows) ? rows : [];
  } catch (err: unknown) {
    log.debug(`[magnetbank] leitura nativa do acervo falhou: ${log.errorMessage(err)}`);
    return [];
  }
}
