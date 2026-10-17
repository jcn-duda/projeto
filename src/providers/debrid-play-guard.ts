import type { Stream } from '../../types/domain.js';
import { nativeCore } from '../utils/native-core.js';
import { coreJson } from '../utils/native-json.js';

/**
 * Casca fina da decisão de SAÍDA de um stream após a checagem de cache — a
 * regra vive em `adom_core::play_disposition` (napi `playDispositions`, em
 * LOTE). Nada de fallback: o núcleo é obrigatório.
 *
 * Ponto ÚNICO da regra "pack multiobra ADMITIDO nunca vira torrent P2P
 * inteiro": o cliente baixaria a coleção toda e tocaria o MAIOR arquivo, quase
 * sempre o filme errado. A marca é `_multiWorkAdmitted` (feature
 * BR_MULTIWORK_PACKS, nativa por padrão; `false` é o kill-switch), nunca o
 * `_multiWork` genérico: com o kill-switch desligado nada é admitido e o
 * comportamento anterior é preservado.
 *
 * - `resolve`: sai pela URL /resolve (debrid). Cached, ou não-cached com
 *   `resolveUncached=true` — o contrato explícito do operador é respeitado.
 * - `p2p`: torrent puro (comportamento antigo, só sem admissão multiobra).
 * - `drop`: multiobra admitida fora do cache sem `resolveUncached`; não vai à lista.
 *
 * `degraded` é o ramo `known:false` do `applyDebrid`: como o serviço não soube
 * informar cache, o comportamento histórico manda TUDO pelo `/resolve`. O pack
 * admitido continua fora dessa regra — uma coleção fria só resolve com
 * `resolveUncached`; sem o knob ela é descartada, nunca oferecida. A ORDEM dos
 * ramos é a regra, não estilo — multiobra ganha do degradado.
 *
 * O oráculo do golden é o TypeScript autoritativo do worktree `../adom-esm`
 * (`npm run golden:play-disposition:check`); as marcas são a VERDADE do JS
 * (string vazia e `0` são falsos), por isso a conversão para booleano é feita
 * aqui, antes da travessia.
 */
export type PlayDisposition = 'resolve' | 'p2p' | 'drop';

/** Fatos de UM stream no lote — o formato que cruza para o napi. */
export interface PlayBatchFacts {
  /** `Boolean(stream.infoHash)`. */
  hasInfoHash: boolean;
  /** `Boolean(stream._multiWorkAdmitted)`. */
  multiWorkAdmitted: boolean;
  /** `Boolean(stream.infoHash && cached.has(hash))`. */
  cached: boolean;
}

/** Opções comuns do lote (as mesmas por stream na chamada avulsa). */
export interface PlayDispositionOptions {
  resolveUncached: boolean;
  degraded?: boolean;
}

/** Opções da chamada avulsa: `cached` é por stream. */
export interface PlayDispositionSingleOptions extends PlayDispositionOptions {
  cached: boolean;
}

/** Superfície do núcleo que esta casca consome. */
interface PlayGuardCore {
  playDispositions(inputJson: string): string;
}

function core(): PlayGuardCore {
  return nativeCore<PlayGuardCore>();
}

/** Fatos de um stream: as três marcas que o núcleo lê. */
function factsOf(stream: Stream, cached: boolean): PlayBatchFacts {
  return {
    hasInfoHash: Boolean(stream.infoHash),
    multiWorkAdmitted: Boolean(stream._multiWorkAdmitted),
    cached,
  };
}

/** Uma travessia para N streams: disposição por fato, na MESMA ordem. */
function run(facts: readonly PlayBatchFacts[], opts: PlayDispositionOptions): PlayDisposition[] {
  return JSON.parse(core().playDispositions(coreJson({
    streams: facts,
    resolveUncached: opts.resolveUncached,
    degraded: opts.degraded ?? false,
  }))) as PlayDisposition[];
}

/**
 * Lote para o caminho de `applyDebrid`: o chamador passa a lista inteira e o
 * conjunto de hashes em cache; o núcleo devolve uma disposição por stream.
 */
function playDispositions(
  streams: readonly Stream[],
  cached: ReadonlySet<string>,
  opts: PlayDispositionOptions,
): PlayDisposition[] {
  return run(
    streams.map((stream) => factsOf(stream, Boolean(stream.infoHash && cached.has(stream.infoHash)))),
    opts,
  );
}

/** Chamada avulsa, mantida para o `materialize` e para a compatibilidade. */
function playDisposition(stream: Stream, opts: PlayDispositionSingleOptions): PlayDisposition {
  return run([factsOf(stream, Boolean(opts.cached))], opts)[0];
}

export { playDispositions, playDisposition };
