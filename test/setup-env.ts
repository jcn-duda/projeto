/**
 * Ambiente da suíte, carregado por `--import` ANTES de qualquer módulo de
 * produção.
 *
 * Existe por causa de uma diferença real entre CommonJS e ESM: `require` roda na
 * ordem em que aparece no arquivo, então `process.env.X = ...` antes do require
 * funcionava. Em ESM os `import` são **içados** e executam antes da primeira
 * linha do módulo — a atribuição chega tarde, e quem lê a variável no topo do
 * próprio módulo (como `src/utils/cache.ts` no `openDatabase`) já leu o valor
 * antigo.
 *
 * O sintoma era silencioso: dez arquivos de teste declaravam
 * `process.env.CACHE_PERSIST = 'false'` e mesmo assim abriam o SQLite de
 * verdade, tocando `data/cache.db` e compartilhando estado entre si.
 */
process.env.CACHE_PERSIST = 'false';
