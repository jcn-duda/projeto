const config = require('../config');
const { accountScope } = require('../utils/request-key');
const { json, pickFile, wait, batched } = require('./common');
const held = require('./protected');

// v4.1: a AllDebrid descontinuou /v4/magnet/status ("DISCONTINUED"), o que
// fazia toda resolução falhar com 502. upload e link/unlock respondem em ambas.
const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

async function call(apiKey, path, params = {}, { method = 'GET', body, timeout } = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('agent', AGENT);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeout,
  });
  // A AllDebrid responde 200 com { status: "error" }; o HTTP sozinho não basta.
  if (data.status === 'error') {
    throw new Error(data.error?.message || data.error?.code || 'alldebrid retornou erro');
  }
  return data.data;
}

/**
 * O /magnet/instant foi removido, mas o próprio /magnet/upload responde
 * `ready` por magnet — é essa a checagem de cache da AllDebrid. Aceita lote.
 *
 * O que não está pronto é removido em seguida: sem isso cada consulta deixaria
 * um download rodando na conta (chegaram a 226 fantasmas antes disso existir).
 */
async function checkCached(apiKey, infoHashes, { timeoutMs } = {}) {
  const drop = [];
  const account = accountScope(apiKey);

  const result = await batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const data = await call(
      apiKey,
      '/magnet/upload',
      { 'magnets[]': batch },
      { timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout },
    );
    const ready = [];
    for (const magnet of data?.magnets || []) {
      if (magnet.ready) ready.push(String(magnet.hash).toLowerCase());
      // Hash em download automático não entra na limpeza: ele está "não pronto"
      // justamente porque pedimos que baixasse.
      else if (magnet.id && !held.isHeld(magnet.hash, account)) drop.push(magnet.id);
    }
    return ready;
  }, { timeoutMs });

  if (drop.length && config.debrid.dropUncached) {
    // Em paralelo e sem travar a busca: limpeza é efeito colateral, não resposta.
    Promise.allSettled(drop.map((id) => call(apiKey, '/magnet/delete', { id }))).then(() =>
      console.log(`[alldebrid] ${drop.length} magnet(s) não cacheado(s) removido(s) da conta`),
    );
  }
  return result;
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
  const account = accountScope(apiKey);
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
    // Sem isso o magnet fica baixando na conta pra sempre: como a AllDebrid não
    // tem consulta de cache, TODO play que falha deixa um download fantasma
    // (foram 226 acumulados até este bug aparecer). O upload é idempotente,
    // então apagar não custa nada — se o usuário voltar, ele é reenviado.
    // Idem no play: se o usuário clicou num BR que está baixando por nossa
    // conta, apagar aqui jogaria fora o progresso.
    if (config.debrid.dropUncached && !held.isHeld(infoHash, account)) {
      try {
        await call(apiKey, '/magnet/delete', { id: magnet.id });
      } catch (err) {
        console.warn('[alldebrid] não consegui remover o magnet:', err.message);
      }
    }
    return null;
  }

  const files = flattenFiles(info.files);
  const file = pickFile(files, { season, episode });
  if (!file) return null;

  const unlocked = await call(apiKey, '/link/unlock', { link: file.link });
  return unlocked?.link || null;
}

/**
 * O /magnet/upload já é o próprio "começa a baixar" da AllDebrid: o mesmo
 * endpoint que responde `ready` para o cache é o que enfileira o que não está.
 */
async function enqueue(apiKey, infoHash) {
  const data = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  return Boolean(data?.magnets?.length);
}

module.exports = {
  enqueue,
  id: 'alldebrid',
  label: 'AllDebrid',
  short: 'AD',
  // Não pelo /magnet/instant (removido), e sim pelo `ready` do /magnet/upload.
  cacheCheck: true,
  // A consulta cria transferência; aborto sem resposta perde o id necessário
  // para remover os magnets que não estavam prontos.
  abortSafeCacheCheck: false,
  keyUrl: 'https://alldebrid.com/apikeys',
  checkCached,
  resolveLink,
};
