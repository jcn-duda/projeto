/**
 * Carimbo de versão nos imports RELATIVOS dos módulos de cliente.
 *
 * O HTML já carrega o entry com `?v=<fingerprint>`, mas os imports internos
 * (`./saude-model.js`, `../action.js`) são resolvidos pelo browser a partir do
 * entry e ficam SEM query: a URL de um módulo filho nunca muda entre deploys.
 * O addon serve esses filhos com `no-cache` + ETag justamente por isso, só que
 * o header da origem não é a última palavra — em 2026-09-17 a Cloudflare na
 * frente de powermovie.net reescrevia para `max-age=14400`, e o painel de um
 * operador com a aba aberta continuou rodando o JS de antes do deploy por horas
 * enquanto recebia dados novos do poll (veredito errado sobre dado certo).
 *
 * Carimbar a query resolve na raiz e não depende de CDN nenhum: a URL do filho
 * passa a mudar junto com o conteúdo, então nem proxy, nem browser, nem cache
 * corporativo consegue servir a versão velha — é o mesmo contrato que os
 * entries já tinham.
 *
 * Só specifier RELATIVO é carimbado. Bare specifier (`node:fs`, pacote) não
 * existe nesses bundles e, se aparecesse, uma query o quebraria; URL absoluta
 * aponta para fora e não é nossa para versionar.
 */

/**
 * `from './x.js'`, `import './x.js'` e `import('./x.js')` — as três formas que
 * o browser resolve. O specifier já com query é deixado em paz (`[^'"?]+`):
 * carimbar duas vezes geraria `?v=a?v=b` e quebraria o caminho.
 */
const RELATIVE_IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"?]*\.js)\2/g;

export function stampRelativeImports(code: string, version: string): string {
  const v = String(version || '');
  if (!v) return String(code || '');
  return String(code || '').replace(
    RELATIVE_IMPORT_RE,
    (_match, head: string, quote: string, spec: string) => `${head}${quote}${spec}?v=${v}${quote}`,
  );
}

/** Quantos specifiers relativos o módulo tem — o teste usa para provar que um
 * arquivo com imports não passou reto pelo carimbo. */
export function countRelativeImports(code: string): number {
  return (String(code || '').match(RELATIVE_IMPORT_RE) || []).length;
}
