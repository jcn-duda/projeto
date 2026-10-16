/**
 * Ponte para o núcleo Rust (`rust/crates/adom-napi`, addon nativo napi-rs).
 *
 * O núcleo é obrigatório: onde o Rust decide (ranking, 💾 de episódio, debrid,
 * índice, autofetch, `normalizeTitle`), o TS saiu do branch e o oráculo é o
 * `esm`. O boot do processo (`addon.ts`) o carrega; testes e scripts o
 * carregam sob demanda (`requireCore`, em `native-core.ts`).
 *
 * `RUST_CORE` (`off|shadow|on`) sobra só para os vereditos de release em lote
 * (`rust-shadow.ts`): `on` faz o filtro de relevância ler o lote Rust, `shadow`
 * compara fora da resposta.
 */
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { nativeCore, loadedNativeCore, setNativeCore, setNativeCorePath, nativeCorePath } from './native-core.js';
import type { PickCore } from '../debrid/file-selector.js';
import type { CacheCore } from './rust-debrid-cache.js';
import type { RdCore } from './rust-debrid-rd.js';
import type { CleanCore } from './rust-debrid-clean.js';
import type { ReleaseIndexCore } from './rust-release-index.js';
import type { AutofetchCore } from './rust-autofetch.js';
import type { RankingCore } from './rust-stream-ranking.js';
import type { EpisodeSizeCore } from './rust-episode-size.js';
import type { ReleaseProbe, ReleaseVerdict } from './rust-shadow.js';
import type { RelevanceCore } from './rust-relevance.js';

/** Contrato do lote (`evaluateReleases`); opcional porque binário antigo não o tem. */
export type BatchCore = { evaluateReleases(probes: ReleaseProbe[]): ReleaseVerdict[] };

export type CrawlPageParsedNapi = {
  url: string;
  status: string;
  imdb?: string;
  title?: string;
  year?: number;
  originalTitle?: string;
  season?: number;
  workType?: string;
  releases: Array<{
    title: string;
    magnet: string;
    indexer: string;
    tracker: string;
    isBr: boolean;
    seeders: number;
    size?: string;
  }>;
  groups: Array<{
    season?: number;
    episode?: number;
    releases: Array<{
      title: string;
      magnet: string;
      indexer: string;
      tracker: string;
      isBr: boolean;
      seeders: number;
      size?: string;
    }>;
  }>;
  unlocated: Array<{
    title: string;
    magnet: string;
    indexer: string;
    tracker: string;
    isBr: boolean;
    seeders: number;
    size?: string;
  }>;
  error?: string;
};

export type CrawlCore = {
  parseCrawlPage(site: string, kind: string, url: string, html: string): CrawlPageParsedNapi;
};

export type NapiCore = { normalizeTitle(title: string): string } & Partial<BatchCore> & Partial<CrawlCore> & Partial<PickCore> & Partial<CacheCore> & Partial<RdCore> & Partial<CleanCore> & Partial<ReleaseIndexCore> & Partial<AutofetchCore> & Partial<RankingCore> & Partial<EpisodeSizeCore> & Partial<RelevanceCore>;

/** Núcleo já carregado (boot ou primeira chamada); null antes disso. */
function getCore(): NapiCore | null {
  return loadedNativeCore<NapiCore>();
}

/** Núcleo para as áreas só-Rust: carrega se preciso e lança se faltar. */
function requireCore(): NapiCore {
  return nativeCore<NapiCore>();
}

function getMode(): 'off' | 'shadow' | 'on' {
  return config.rustCore.mode;
}

function install() {
  // O núcleo é obrigatório: o boot o carrega sempre, para o binário ausente
  // aparecer aqui e não na primeira busca, e para o custo do primeiro
  // carregamento não cair numa resposta.
  setNativeCorePath(config.rustCore.path);
  try {
    nativeCore<NapiCore>();
    log.info(`[rust] núcleo carregado (${nativeCorePath()})`);
  } catch (err) {
    log.error(`[rust] ${log.errorMessage(err)}; busca, debrid e autofetch vão falhar`);
  }
}

/**
 * Só para TESTE: injeta um núcleo (stub) sem carregar o `.node`. O boot real
 * usa `install()`; nenhum caminho de produção chama isto.
 */
function setCoreForTest(core: NapiCore | null): void {
  setNativeCore(core);
}

export { install, getCore, requireCore, getMode, setCoreForTest };
