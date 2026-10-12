/**
 * Entrada de registro do golden de `src/utils/cache-keys.ts`.
 *
 * Cobre os quatro exports puros do módulo: `NAMESPACE_VERSIONS` (op `versions`),
 * `LEGACY_PREFIXES` (op `legacy`), `prefix()` (op `prefix`) e
 * `magMetaCountsKey()` (op `magmeta`). O op `key` não chama uma função do fonte:
 * ele reproduz a COMPOSIÇÃO que os chamadores fazem hoje
 * (`${prefix('autofetch')}dead:${adapter}:${conta}:${hash}`), que é o contrato
 * que `cache_key` do porte precisa cumprir byte a byte.
 *
 * Não há caso de namespace ausente da tabela: o TS montaria `ns:undefined:`, um
 * prefixo fantasma. O porte devolve vazio de propósito (ver o cabeçalho de
 * `rust/crates/adom-core/src/cache_keys.rs`); isso é divergência documentada e
 * presa por teste próprio, não paridade.
 *
 * Corpus gerado por `build-corpus-cache.mjs`; gerador/verificador: `gen-cache.mjs`.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT = 'dist/src/utils/cache-keys.js';

const load = () => import(pathToFileURL(path.join(REPO, ARTIFACT)).href);

/** Partes por namespace, colhidas dos chamadores reais em `src/`. */
const SAMPLE_PARTS = {
  streams: ['movie', 'tt0111111'],
  autofetch: ['dead', 'jackett', '1', 'aa4f91c3d0'],
  raw: ['jackett', '1', 'movie', 'tt0111111'],
  dinv: ['torrentio', '1'],
  davail: ['a1b2c3d4e5f6'],
  mag: ['a1b2c3d4e5f6a7b8c9d0'],
  mag_meta: ['counts'],
  rdc: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  rdt: ['trt', 'movie', 'tt0139217'],
  rdq: ['wq'],
  idx: ['movie', 'tt0111111'],
  harvest: ['seen', 'deadbeef'],
  notify: ['release:1'],
  seed: ['cohort'],
  cfg: ['runtime'],
  adprot: ['alldebrid', '2', 'a1b2c3'],
  adsub: ['2', 'a1b2c3'],
  adrm: ['2', 'a1b2c3'],
  fsz: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  tsz: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  vres: ['a1b2c3', '9f86d081'],
};

const push = (cases, id, input, note) => cases.push({ id, input: JSON.stringify(input), note });

/** Casos do golden, derivados da própria tabela viva (todo namespace coberto). */
export async function casesKeys() {
  const mod = await load();
  const names = Object.keys(mod.NAMESPACE_VERSIONS);
  const cases = [];

  push(cases, 'ck-versions', { op: 'versions' }, 'tabela completa na ordem de inserção');
  push(cases, 'ck-legacy', { op: 'legacy' }, 'prefixos aposentados no boot');
  push(cases, 'ck-magmeta', { op: 'magmeta' }, 'chave única do agregado do MagnetDB');
  names.forEach((ns, i) =>
    push(cases, `ck-prefix-${String(i + 1).padStart(2, '0')}`, { op: 'prefix', ns }, `prefixo de ${ns}`));
  names.forEach((ns, i) =>
    push(cases, `ck-key-${String(i + 1).padStart(2, '0')}`, { op: 'key', ns, parts: SAMPLE_PARTS[ns] ?? ['x'] }, `chave composta de ${ns}`));

  // Casos de forma, não de conteúdo.
  push(cases, 'ck-key-empty-parts', { op: 'key', ns: 'raw', parts: [] }, 'sem parte: só o prefixo');
  push(cases, 'ck-key-one-part', { op: 'key', ns: 'rdq', parts: ['wq'] }, 'uma parte');
  push(cases, 'ck-key-blank-part', { op: 'key', ns: 'idx', parts: ['', 'movie'] }, 'parte vazia no meio');
  push(cases, 'ck-key-trailing-blank', { op: 'key', ns: 'idx', parts: ['movie', ''] }, 'parte vazia no fim');
  push(cases, 'ck-key-colon-in-part', { op: 'key', ns: 'streams', parts: ['series:tv:tt0159256', 's1e2'] }, 'parte que já traz dois-pontos');
  // Acento em escape no fonte do gerador: o corpus sai UTF-8 válido do Node.
  push(cases, 'ck-key-unicode', { op: 'key', ns: 'streams', parts: ['movie', 't\u00EDtulo-acentuado'] }, 'sem normalização: byte a byte');
  push(cases, 'ck-key-uppercase', { op: 'key', ns: 'fsz', parts: ['A1B2C3'] }, 'maiúsculo fica como está (toLowerCase é do chamador)');
  push(cases, 'ck-key-many-parts', { op: 'key', ns: 'adprot', parts: ['jackett', '3', 'aa', 'bb', 'cc'] }, 'cinco partes');
  push(cases, 'ck-prefix-repeat', { op: 'prefix', ns: 'idx' }, 'idx está em v14, não em v1');

  return cases;
}

/** Oráculo: executa o `dist` vivo e devolve a saída textual de um caso. */
export async function oracleKeys() {
  const mod = await load();
  return (input) => {
    const c = JSON.parse(input);
    switch (c.op) {
      case 'versions':
        return JSON.stringify(Object.entries(mod.NAMESPACE_VERSIONS));
      case 'legacy':
        return JSON.stringify(mod.LEGACY_PREFIXES);
      case 'magmeta':
        return mod.magMetaCountsKey();
      case 'prefix':
        return mod.prefix(c.ns);
      case 'key': {
        const parts = (c.parts ?? []).map((p) => String(p));
        return parts.length ? `${mod.prefix(c.ns)}${parts.join(':')}` : mod.prefix(c.ns);
      }
      default:
        throw new Error(`op desconhecida: ${c.op}`);
    }
  };
}

export default {
  id: 'cache-keys/namespace-versions',
  name: 'prefix',
  source: 'src/utils/cache-keys.ts',
  artifact: ARTIFACT,
  corpus: 'scripts/golden/corpus-cache-keys.json',
  outJsonl: 'rust/golden/cache-keys.jsonl',
  outManifest: 'rust/golden/cache-keys.manifest.json',
  cases: casesKeys,
  resolve: oracleKeys,
};
