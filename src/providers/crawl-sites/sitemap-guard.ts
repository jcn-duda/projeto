/**
 * Uma resposta 200 só prova descoberta quando há estrutura reconhecida e uma
 * URL de obra no escopo. A contagem de obras é feita antes do corte incremental
 * e do gate de séries, para que uma rodada sem novidade continue sendo sucesso.
 */
export function assertSitemapScope(parsedRows: number, scopedWorkRows: number): void {
  if (parsedRows === 0) throw new Error('sitemap_sem_entradas_reconhecidas');
  if (scopedWorkRows === 0) throw new Error('sitemap_sem_obras_do_escopo');
}
