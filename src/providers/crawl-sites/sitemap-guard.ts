/**
 * Uma resposta 200 só prova descoberta quando há estrutura reconhecida e uma
 * URL de obra no escopo. A contagem de obras é feita antes do corte incremental
 * e do gate de séries, para que uma rodada sem novidade continue sendo sucesso.
 */
function withoutHtmlComments(source: string): string {
  return String(source || '').replace(/<!--[\s\S]*?-->/g, '');
}

/** XML estrutural, sem confundir imagem isolada, comentário ou página HTML. */
export function isXmlSitemapShape(source: string): boolean {
  return /<(?:urlset|sitemapindex|sitemap|url|loc)(?=[\s/>])/i.test(withoutHtmlComments(source));
}

/** O viewer Yoast do Vaca só é reconhecido pela tabela e cabeçalhos próprios. */
export function isVacaSitemapShape(source: string): boolean {
  const text = withoutHtmlComments(source);
  if (isXmlSitemapShape(text)) return true;
  return /<table\b(?=[^>]*\bid\s*=\s*["']sitemap["'])[^>]*>[\s\S]*?<thead\b[^>]*>[\s\S]*?<th\b[^>]*>\s*URL\s*<\/th>[\s\S]*?<th\b[^>]*>\s*Images\s*<\/th>[\s\S]*?<th\b[^>]*>\s*Last Modified\s*<\/th>[\s\S]*?<\/thead>[\s\S]*?<tbody\b[^>]*>[\s\S]*?<\/tbody>[\s\S]*?<\/table>/i.test(text);
}

export function assertSitemapScope(
  parsedRows: number,
  scopedWorkRows: number,
  shapeRecognized = true,
): void {
  if (parsedRows === 0 && !shapeRecognized) throw new Error('sitemap_formato_desconhecido');
  if (parsedRows === 0) throw new Error('sitemap_sem_entradas_reconhecidas');
  if (scopedWorkRows === 0) throw new Error('sitemap_sem_obras_do_escopo');
}

/** O erro de formato é fixo; não repita nele a URL nem o corpo do fetch. */
export function sitemapFailureMessage(loc: string, reason: string): string {
  return reason === 'sitemap_formato_desconhecido' ? reason : `${loc}: ${reason}`;
}
