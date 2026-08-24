'use strict';

// Cardigann pode encapsular repetidamente a URL de /resolve no parâmetro url.
// Os nomes externos permanecem do profile para não mudar seu contrato público.
function unwrapResolverUrl(value, selfUrl, seed = {}, options = {}) {
  const paths = options.paths || ['/resolve'];
  const fields = options.fields || { index: 'i', hash: 'h', count: 'n' };
  let url = value;
  const result = { url };
  for (const field of Object.keys(fields)) result[field] = seed[field] ?? null;

  for (let hop = 0; hop < 3; hop += 1) {
    let inner;
    try {
      inner = new URL(url, selfUrl);
    } catch {
      break;
    }
    if (!paths.includes(inner.pathname) || !inner.searchParams.get('url')) break;
    url = inner.searchParams.get('url');
    for (const [field, param] of Object.entries(fields)) {
      result[field] = inner.searchParams.get(param) ?? result[field];
    }
  }
  result.url = url;
  return result;
}

module.exports = { unwrapResolverUrl };
