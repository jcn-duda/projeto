const { json, pickFile, wait } = require('./common');

// v4.1: a AllDebrid descontinuou /v4/magnet/status ("DISCONTINUED"), o que
// fazia toda resolução falhar com 502. upload e link/unlock respondem em ambas.
const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

async function call(apiKey, path, params = {}, { method = 'GET', body } = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('agent', AGENT);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, { method, headers: { Authorization: `Bearer ${apiKey}` }, body });
  // A AllDebrid responde 200 com { status: "error" }; o HTTP sozinho não basta.
  if (data.status === 'error') {
    throw new Error(data.error?.message || data.error?.code || 'alldebrid retornou erro');
  }
  return data.data;
}

/**
 * A AllDebrid removeu o endpoint de disponibilidade instantânea; não dá mais
 * pra perguntar em lote o que está em cache.
 */
async function checkCached() {
  return new Set();
}

/**
 * Na v4.1 os arquivos vêm como árvore, não como lista de links: `n` é o nome,
 * `e` são as entradas de uma pasta, e a folha traz `s` (tamanho) e `l` (link).
 */
function flattenFiles(nodes, prefix = '') {
  const out = [];
  for (const node of nodes || []) {
    const path = prefix ? `${prefix}/${node.n}` : node.n;
    if (Array.isArray(node.e)) {
      out.push(...flattenFiles(node.e, path));
    } else if (node.l) {
      out.push({ path, size: node.s, link: node.l });
    }
  }
  return out;
}

async function resolveLink(apiKey, infoHash, { season, episode } = {}) {
  const upload = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  const magnet = (upload?.magnets || [])[0];
  if (!magnet?.id) return null;

  let status = await call(apiKey, '/magnet/status', { id: magnet.id });
  let info = status?.magnets;
  // A resposta às vezes vem como lista de um item só.
  if (Array.isArray(info)) info = info[0];

  // Em cache, vira "Ready" na hora. Se não, o torrent entraria em download e o
  // play ficaria travado — melhor devolver nada e deixar escolher outro.
  for (let attempt = 0; attempt < 3 && info && info.status !== 'Ready'; attempt += 1) {
    await wait(700);
    status = await call(apiKey, '/magnet/status', { id: magnet.id });
    info = Array.isArray(status?.magnets) ? status.magnets[0] : status?.magnets;
  }
  if (!info || info.status !== 'Ready') {
    console.warn(`[alldebrid] torrent não está em cache (status: ${info?.status})`);
    return null;
  }

  const files = flattenFiles(info.files);
  const file = pickFile(files, { season, episode });
  if (!file) return null;

  const unlocked = await call(apiKey, '/link/unlock', { link: file.link });
  return unlocked?.link || null;
}

module.exports = {
  id: 'alldebrid',
  label: 'AllDebrid',
  cacheCheck: false,
  keyUrl: 'https://alldebrid.com/apikeys',
  checkCached,
  resolveLink,
};
