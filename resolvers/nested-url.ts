// Cardigann pode encapsular repetidamente a URL de /resolve no parâmetro url.
// Os nomes externos permanecem do profile para não mudar seu contrato público.

/** Opções do desempacotamento (bludv: /dl + paths próprios). */
export interface UnwrapResolverOptions {
  paths?: string[];
  fields?: Record<string, string>;
}

/** Valores iniciais dos campos (índice/hash/count que o cardigann propaga). */
export interface UnwrapResolverSeed {
  [field: string]: string | null | undefined;
}

/** URL final mais os campos desempacotados; ausente vira `null`. */
export interface UnwrappedResolverUrl {
  url: string;
  [field: string]: string | null;
}

function unwrapResolverUrl(
  value: string,
  selfUrl: string,
  seed: UnwrapResolverSeed = {},
  options: UnwrapResolverOptions = {},
): UnwrappedResolverUrl {
  const paths = options.paths || ['/resolve'];
  const fields = options.fields || { index: 'i', hash: 'h', count: 'n' };
  let url = value;
  const result: UnwrappedResolverUrl = { url };
  for (const field of Object.keys(fields)) result[field] = seed[field] ?? null;

  for (let hop = 0; hop < 3; hop += 1) {
    let inner: URL;
    try {
      inner = new URL(url, selfUrl);
    } catch {
      break;
    }
    const innerTarget = inner.searchParams.get('url');
    if (!paths.includes(inner.pathname) || !innerTarget) break;
    url = innerTarget;
    for (const [field, param] of Object.entries(fields)) {
      result[field] = inner.searchParams.get(param) ?? result[field];
    }
  }
  result.url = url;
  return result;
}

export { unwrapResolverUrl };
