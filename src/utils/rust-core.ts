/**
 * Ponte para o núcleo Rust (`rust/crates/adom-napi`, addon nativo napi-rs).
 *
 * Instalado só no boot do PROCESSO (`addon.ts`), nunca no `createApp`: os
 * testes e os oráculos de golden seguem medindo o TS puro. Falha ao carregar
 * o `.node` (binário ausente, libc errada, ABI) vira log + TS — a ponte nunca
 * derruba o addon.
 *
 * Modos (`RUST_CORE`): `shadow` roda os dois e loga quando o Rust diverge,
 * respondendo SEMPRE com o TS; `on` responde com o Rust e cai no TS se ele
 * lançar. Só promova para `on` depois de dias de shadow sem divergência.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { installNormalizeTitle } from './title-normalization.js';
import { installDebridPickHook } from './rust-debrid-pick.js';
import type { PickCore } from './rust-debrid-pick.js';
import { installDebridCacheHook } from './rust-debrid-cache.js';
import type { CacheCore } from './rust-debrid-cache.js';
import type { ReleaseProbe, ReleaseVerdict } from './rust-shadow.js';

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

export type NapiCore = { normalizeTitle(title: string): string } & Partial<BatchCore> & Partial<CrawlCore> & Partial<PickCore> & Partial<CacheCore>;

const _require = createRequire(import.meta.url);

// dist/src/utils/rust-core.js → dist/rust/adom_napi.node
const DEFAULT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rust/adom_napi.node');

let loggedDiffs = 0;
// Núcleo carregado no boot: fica disponível para o shadow em lote (`rust-shadow.ts`).
let loadedCore: NapiCore | null = null;

/** Núcleo carregado no boot; null com RUST_CORE=off ou se não carregou. */
function getCore(): NapiCore | null {
  return loadedCore;
}

function getMode(): 'off' | 'shadow' | 'on' {
  return config.rustCore.mode;
}

function load(file: string): NapiCore | null {
  try {
    const mod = _require(file) as Partial<NapiCore>;
    const hasTitle = typeof mod.normalizeTitle === 'function';
    const hasPick = typeof mod.pickFile === 'function';
    if (!hasTitle && !hasPick) throw new Error('normalizeTitle e pickFile ausentes no módulo');
    return mod as NapiCore;
  } catch (err) {
    log.warn(`[rust] núcleo não carregou (${file}); seguindo só com TS:`, log.errorMessage(err));
    return null;
  }
}

function logDiff(input: string, ts: string, rust: string) {
  metrics.count('rust.normalizeTitle.diff');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(`[rust] normalizeTitle divergiu: entrada=${JSON.stringify(input)} ts=${JSON.stringify(ts)} rust=${JSON.stringify(rust)}`);
}

function installTitle(core: NapiCore, mode: 'shadow' | 'on') {
  if (typeof core.normalizeTitle !== 'function') {
    log.warn('[rust] normalizeTitle ausente no núcleo; seguindo só com TS');
    return;
  }
  if (mode === 'shadow') {
    installNormalizeTitle((input, ts) => {
      const expected = ts(input);
      metrics.count('rust.normalizeTitle.calls');
      try {
        const got = core.normalizeTitle(input);
        if (got !== expected) logDiff(input, expected, got);
      } catch (err) {
        metrics.count('rust.normalizeTitle.error');
        log.debug('[rust] normalizeTitle lançou:', log.errorMessage(err));
      }
      return expected;
    });
  } else {
    installNormalizeTitle((input, ts) => {
      metrics.count('rust.normalizeTitle.calls');
      try {
        return core.normalizeTitle(input);
      } catch (err) {
        metrics.count('rust.normalizeTitle.error');
        log.debug('[rust] normalizeTitle lançou; usando TS:', log.errorMessage(err));
        return ts(input);
      }
    });
  }
  log.info(`[rust] normalizeTitle em modo ${mode}`);
}

function install() {
  const titleMode = config.rustCore.mode;
  const fileMode = config.rustDebrid.file;
  const cacheMode = config.rustDebrid.cache;
  // Tudo off: não carrega o .node, como antes.
  if (titleMode === 'off' && fileMode === 'off' && cacheMode === 'off') return;
  const file = config.rustCore.path || DEFAULT_PATH;
  const core = load(file);
  if (!core) return;
  loadedCore = core;
  if (titleMode !== 'off') installTitle(core, titleMode);
  if (fileMode !== 'off') installDebridPickHook(() => loadedCore);
  if (cacheMode !== 'off') installDebridCacheHook(() => loadedCore);
  log.info(`[rust] núcleo carregado (${file}); pickFile=${fileMode} cache=${cacheMode}`);
}

/**
 * Só para TESTE: injeta um núcleo (stub) sem carregar o `.node`. O boot real
 * usa `install()`; nenhum caminho de produção chama isto.
 */
function setCoreForTest(core: NapiCore | null): void {
  loadedCore = core;
}

export { install, getCore, getMode, setCoreForTest };
