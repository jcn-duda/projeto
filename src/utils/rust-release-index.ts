/**
 * Sombra do índice de releases em Rust (`releaseIndexMediaMerge`, porte de
 * `release-index-media.ts`): na escrita do índice (`record`), o TS calcula a
 * fonte de mídia de cada release e o Rust calcula a mesma em UMA chamada napi
 * por release, AGENDADA com `setImmediate` — o índice grava dezenas de
 * releases por busca e o napi é ~2× mais lento por chamada, então nada roda no
 * caminho da resposta. A decisão continua no TS: `record` grava sempre o valor
 * do TS; divergência vira métrica (`rust.release_index.*`) e log com teto.
 *
 * Em `RUST_RELEASE_INDEX=off` (default), ou sem o núcleo carregado, é no-op.
 * `shadow` e `on` fazem a mesma comparação — a promoção não muda o código, só
 * um dia trocar o valor gravado.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

/** Linha do acervo já lida pelo TS (`bankByHash` achatada); sem SQLite no Rust. */
export type BankRowNapi = { hash: string; uri: string; title: string };

/** Entrada de `mergeMediaSource`, com o veredito do TS já calculado. */
export type MediaSourceProbe = {
  magnet: string;
  magnetUri: string;
  guid: string;
  title: string;
  hash: string;
  priorMediaSource: string | null;
  bank: BankRowNapi[];
  ts: string | null;
};

export type ReleaseIndexCore = {
  releaseIndexMediaMerge?(
    magnet: string | null,
    magnetUri: string | null,
    guid: string | null,
    title: string,
    hash: string,
    priorMediaSource: string | null,
    bank: BankRowNapi[],
  ): string | null;
};

type GetCore = () => ReleaseIndexCore | null;

let getCore: GetCore | null = null;
let loggedDiffs = 0;
let warnedNoMerge = false;

function noteMissing() {
  if (warnedNoMerge) return;
  warnedNoMerge = true;
  log.info('[rust] núcleo sem releaseIndexMediaMerge (binário antigo); sombra do índice desligada');
}

function logDiff(p: MediaSourceProbe, rust: string | null) {
  metrics.count('rust.release_index.divergence');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(
    `[rust] release-index divergiu: titulo=${JSON.stringify(p.title)} `
    + `ts=${JSON.stringify(p.ts)} rust=${JSON.stringify(rust)}`,
  );
}

function runBatch(core: ReleaseIndexCore, probes: MediaSourceProbe[]) {
  const fn = core.releaseIndexMediaMerge;
  if (typeof fn !== 'function') {
    noteMissing();
    return;
  }
  metrics.count('rust.release_index.calls');
  for (const p of probes) {
    let rust: string | null;
    try {
      rust = fn(p.magnet || null, p.magnetUri || null, p.guid || null, p.title, p.hash, p.priorMediaSource, p.bank) ?? null;
    } catch (err) {
      metrics.count('rust.release_index.error');
      log.debug('[rust] release-index lançou:', log.errorMessage(err));
      continue;
    }
    // `?? null`: undefined (TS) e Option::None (napi) são a mesma ausência.
    if (rust !== (p.ts ?? null)) logDiff(p, rust);
  }
}

/**
 * Agenda a comparação em lote de um `record`. Copia as sondas já montadas
 * (strings puras, sem referência aos itens do pipeline) e chama o Rust depois.
 */
export function observeMediaSource(probes: MediaSourceProbe[]): void {
  try {
    if (config.rustReleaseIndex.mode === 'off' || !getCore || probes.length === 0) return;
    const core = getCore();
    if (!core) return;
    const batch = probes.slice();
    setImmediate(() => {
      try {
        runBatch(core, batch);
      } catch (err) {
        metrics.count('rust.release_index.error');
        log.debug('[rust] release-index lançou no lote:', log.errorMessage(err));
      }
    });
  } catch (err) {
    metrics.count('rust.release_index.error');
    log.debug('[rust] release-index não agendou:', log.errorMessage(err));
  }
}

/** A sombra está ligada? O `record` usa para nem montar sondas no off. */
export function captureEnabled(): boolean {
  return config.rustReleaseIndex.mode !== 'off';
}

/** Achata o mapa do acervo (já lido pelo TS) em linhas planas para o napi. */
export function bankRowsNapi(bankByHash: Map<string, { hash: string; uri?: string; title?: string }>): BankRowNapi[] {
  return [...bankByHash.values()].map((row) => ({ hash: row.hash, uri: row.uri || '', title: row.title || '' }));
}

/** Monta a sonda de um item do `record` (só strings, sem referência ao item). */
export function recordProbe(
  item: { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined,
  title: string,
  hash: string,
  priorMediaSource: string | undefined,
  bank: BankRowNapi[],
  ts: string | undefined,
): MediaSourceProbe {
  return {
    magnet: String(item?.magnet || ''),
    magnetUri: String(item?.MagnetUri || ''),
    guid: String(item?.Guid || ''),
    title,
    hash,
    priorMediaSource: priorMediaSource || null,
    bank,
    ts: ts || null,
  };
}

function installReleaseIndexHook(get: GetCore) {
  getCore = get;
}

function resetReleaseIndexHook() {
  getCore = null;
  loggedDiffs = 0;
  warnedNoMerge = false;
}

export { installReleaseIndexHook, resetReleaseIndexHook };
