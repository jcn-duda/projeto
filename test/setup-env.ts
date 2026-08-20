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

// TTLs curtos do cache de disponibilidade por hash (davail, fase 3). Os únicos
// consumidores da camada são os testes do debrid-avail, e o teste de expiração
// espera o timer REAL (~1,3s e ~2,6s). O par <2s,1s> também mantém as entradas
// vivas durante os demais testes do arquivo, que se resolvem em milissegundos.
// `0` desliga cada lado — se a camada estiver inerte, nenhum outro teste muda.
process.env.DEBRID_AVAIL_POS_TTL = '2';
process.env.DEBRID_AVAIL_NEG_TTL = '1';
