const config = require('../config');
const { magnetFor, json, pickFile, batched } = require('./common');

const API = 'https://www.premiumize.me/api';

async function call(apiKey, path, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, { method, body });
  if (data.status && data.status !== 'success') {
    throw new Error(data.message || 'premiumize retornou erro');
  }
  return data;
}

/**
 * Quais desses infoHashes já estão no cache do Premiumize (play instantâneo).
 * Retorna um Set com os hashes disponíveis.
 */
async function checkCached(apiKey, infoHashes) {
  // A API aceita lote; mantemos blocos pra não montar URLs gigantes.
  return batched(infoHashes, config.debrid.batchSize, async (batch) => {
    const data = await call(apiKey, '/cache/check', { params: { 'items[]': batch } });
    const flags = data.response || [];
    return batch.filter((_, idx) => flags[idx]);
  });
}

/**
 * Resolve o link direto de reprodução — só na hora do play, porque o
 * directdl é caro demais pra rodar em cima da lista inteira de torrents.
 */
async function resolveLink(apiKey, infoHash, { season, episode } = {}) {
  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call(apiKey, '/transfer/directdl', { method: 'POST', body });
  const file = pickFile(data.content || [], { season, episode });
  return file ? file.stream_link || file.link : null;
}

module.exports = {
  id: 'premiumize',
  label: 'Premiumize',
  // Único dos quatro que ainda expõe checagem de cache em lote confiável.
  cacheCheck: true,
  keyUrl: 'https://www.premiumize.me/account',
  checkCached,
  resolveLink,
};
