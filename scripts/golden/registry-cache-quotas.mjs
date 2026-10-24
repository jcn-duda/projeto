/**
 * Entrada de registro do golden de `src/utils/cache-quotas.ts` (a parte PURA:
 * `QUOTAS`, `MAX_ENTRIES`, `quotaFor`, `namespaceFor`).
 *
 * Ficam de fora do golden — e do porte — `incrementNamespace`, `removeFromStore`
 * e `quotaOverflow`: recebem o `store` LRU e os contadores por namespace, que
 * pertencem ao motor de cache (`src/utils/cache.ts`), ainda não portado.
 *
 * O op `universe` e o op `validate` não são funções exportadas do fonte: são a
 * CONTA que o teste TS `test/cache-namespaces.test.ts` faz (união de
 * `QUOTAS` com `NAMESPACE_VERSIONS`, menos o `__default`, somada e comparada com
 * o teto). São oráculo aqui porque foi a falta dessa conta que deixou `dinv`,
 * `notify`, `seed` e `harvest` vivendo de fallback até a soma real passar do teto
 * em 1.051. O formato do `universe` é fixo e ordenado de propósito: byte a byte
 * entre JS e Rust sem depender de ordem de chave de objeto.
 *
 * Corpus gerado por `build-corpus-cache.mjs`; gerador/verificador: `gen-cache.mjs`.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT = 'dist/src/utils/cache-quotas.js';

const loadQuotas = () => import(pathToFileURL(path.join(REPO, ARTIFACT)).href);
const loadKeys = () =>
  import(pathToFileURL(path.join(REPO, 'dist/src/utils/cache-keys.js')).href);

/** Chaves realistas, colhidas dos chamadores em `src/` (formato, não conteúdo). */
const SAMPLE_KEYS = [
  'streams:v21:movie:tt0111111',
  'streams:v21:series:tv:tt0159256',
  'idx:v14:movie:tt0139217',
  'autofetch:v3:dead:jackett:1:aa4f91c3d0',
  'autofetch:v3:o:9f86d081884c7d65',
  'autofetch:v3:sup:aa4f91c3d0',
  'raw:v1:jackett:1:movie:tt0111111',
  'rdc:v2:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  'rdt:v1:trt:movie:tt0139217',
  'rdq:v1:wq',
  'mag:v1:a1b2c3d4e5f6a7b8c9d0',
  'mag_meta:v1:counts',
  'davail:v1:a1b2c3d4e5f6',
  'dinv:v1:torrentio:1',
  'fsz:v1:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  'tsz:v1:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  'vres:v1:a1b2c3:9f86d081',
  'adprot:v1:alldebrid:2:a1b2c3',
  'adsub:v1:2:a1b2c3',
  'adrm:v1:2:a1b2c3',
  'harvest:v1:seen:deadbeef',
  'notify:v1:release:1',
  'seed:v1:cohort',
  'cfg:v1:runtime',
  // Sem versão na chave (a dívida conhecida do cabeçalho do fonte): continuam
  // tendo cota própria apesar de não estarem em NAMESPACE_VERSIONS.
  'dlmag:alldebrid:a1b2c3',
  'tmdb:movie:tt0111111',
  'tmdbc:tt0111111',
  'meta:movie:tt0111111',
  'indexer-status:jackett',
  // Aposentados: caem no fallback `__default`.
  'muri:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  'tsj:v1:movie:tt0111111',
  'raw1:jackett:1',
  'dinv1:torrentio:1',
  // Formas degeneradas que o `indexOf(':')`/`slice` do fonte encara.
  'sem-dos-pontos',
  '',
  ':x',
  ':',
  'streams:',
  'Streams:v21:x',
  'streams:v21:',
  'a:b:c:d:e',
  // Acento antes do separador: corta no byte/número de código certo?
  '\u00e3o:tem-versao',
];

const push = (cases, id, input, note) => cases.push({ id, input: JSON.stringify(input), note });

/** Casos do golden, derivados das tabelas vivas (toda cota e todo namespace). */
export async function casesQuotas() {
  const [quotas, keys] = await Promise.all([loadQuotas(), loadKeys()]);
  const cases = [];

  push(cases, 'cq-quotas', { op: 'quotas' }, 'tabela completa na ordem de inserção');
  push(cases, 'cq-max', { op: 'max' }, 'teto global do L1');
  push(cases, 'cq-universe', { op: 'universe' }, 'união QUOTAS ∪ NAMESPACE_VERSIONS + __default');
  push(cases, 'cq-validate', { op: 'validate' }, 'soma do universo abaixo do teto e sem fallback');

  Object.keys(quotas.QUOTAS).forEach((ns, i) =>
    push(cases, `cq-quota-${String(i + 1).padStart(2, '0')}`, { op: 'quota', ns }, `cota de ${ns}`));

  Object.keys(quotas.QUOTAS).forEach((ns) =>
    push(cases, `cq-ns-${ns.replace(/[^a-z0-9_-]/gi, '_')}`, { op: 'namespace', key: `${ns}:qualquer:coisa` }, `namespace de uma chave de ${ns}`));

  Object.keys(keys.NAMESPACE_VERSIONS).forEach((ns) =>
    push(cases, `cq-quota-ns-${ns}`, { op: 'quota', ns }, `namespace versionado tem cota explícita`));

  SAMPLE_KEYS.forEach((key, i) =>
    push(cases, `cq-ns-sample-${String(i + 1).padStart(2, '0')}`, { op: 'namespace', key }, `namespace de ${JSON.stringify(key)}`));

  ['muri', 'tsj', '__default', '__nao_existe__', '', 'Streams', 'raw1'].forEach((ns, i) =>
    push(cases, `cq-quota-fallback-${i + 1}`, { op: 'quota', ns }, `fallback para ${JSON.stringify(ns)}`));

  return cases;
}

/** Forma fixa do `universe`: `{nome:<cota>,...}` ordenado + conta separada. */
async function computeUniverse() {
  const [quotas, keys] = await Promise.all([loadQuotas(), loadKeys()]);
  const universo = new Set([...Object.keys(quotas.QUOTAS), ...Object.keys(keys.NAMESPACE_VERSIONS)]);
  universo.delete('__default');
  const nomes = [...universo].sort();
  const semCota = nomes.filter((ns) => quotas.QUOTAS[ns] === undefined);
  const soma = nomes.reduce((sum, ns) => sum + quotas.quotaFor(ns), 0) + quotas.QUOTAS.__default;
  return { nomes, semCota, soma, max: quotas.MAX_ENTRIES };
}

/** Oráculo: executa o `dist` vivo e devolve a saída textual de um caso. */
export async function oracleQuotas() {
  const mod = await loadQuotas();
  return async (input) => {
    const c = JSON.parse(input);
    switch (c.op) {
      case 'quotas':
        return JSON.stringify(Object.entries(mod.QUOTAS));
      case 'max':
        return String(mod.MAX_ENTRIES);
      case 'quota':
        return String(mod.quotaFor(c.ns));
      case 'namespace':
        return mod.namespaceFor(c.key);
      case 'universe': {
        const u = await computeUniverse();
        return JSON.stringify({
          names: u.nomes.length,
          soma: u.soma,
          max: u.max,
          folga: u.max - u.soma,
          semCota: u.semCota,
          // Pares `[nome, cota]` já ordenados: forma determinística de prender
          // o universo inteiro sem depender de ordem de chave de objeto.
          quotas: u.nomes.map((ns) => [ns, mod.quotaFor(ns)]),
        });
      }
      case 'validate': {
        const u = await computeUniverse();
        return u.semCota.length === 0 && u.soma < u.max ? 'true' : 'false';
      }
      default:
        throw new Error(`op desconhecida: ${c.op}`);
    }
  };
}

export default {
  id: 'cache-quotas/policy',
  name: 'quotaFor',
  source: 'src/utils/cache-quotas.ts',
  artifact: ARTIFACT,
  corpus: 'scripts/golden/corpus-cache-quotas.json',
  outJsonl: 'rust/golden/cache-quotas.jsonl',
  outManifest: 'rust/golden/cache-quotas.manifest.json',
  cases: casesQuotas,
  resolve: oracleQuotas,
};
