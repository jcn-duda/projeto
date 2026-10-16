/**
 * Núcleo Rust carregado (`dist/rust/adom_napi.node`), num módulo-folha: só
 * built-ins do Node. Módulos de base (como `title-normalization.ts`) chamam o
 * núcleo sem importar `config`/`rust-core`, o que fecharia ciclo de import com
 * quem eles mesmos alimentam. O boot (`rust-core.install`) define o caminho
 * configurado; sem ele vale o default ao lado do `dist/`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

// dist/src/utils/native-core.js → dist/rust/adom_napi.node
const DEFAULT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rust/adom_napi.node');

let corePath = DEFAULT_PATH;
let loaded: unknown = null;

/** Caminho do `.node` (vazio = default). Só o boot chama, antes de carregar. */
function setNativeCorePath(file: string): void {
  corePath = file || DEFAULT_PATH;
}

function nativeCorePath(): string {
  return corePath;
}

/**
 * Núcleo para quem o Rust decide SEM reserva TS. Carrega na primeira chamada
 * (testes e scripts que não passam pelo boot também o usam) e lança com
 * instrução quando o binário falta: sem ele a área não tem implementação.
 */
function nativeCore<T>(): T {
  if (loaded) return loaded as T;
  try {
    loaded = _require(corePath);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[rust] núcleo obrigatório ausente (${corePath}): rode \`cargo build -p adom-napi --release\` em rust/ e o build (${why})`,
    );
  }
  return loaded as T;
}

/** Núcleo já carregado, sem tentar carregar; null antes do boot. */
function loadedNativeCore<T>(): T | null {
  return (loaded as T | null) ?? null;
}

/** Boot e testes: fixa o núcleo (o carregado ou um stub; null volta ao lazy). */
function setNativeCore(core: unknown): void {
  loaded = core;
}

export { nativeCore, loadedNativeCore, setNativeCore, setNativeCorePath, nativeCorePath };
