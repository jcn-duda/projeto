const { magnetFor, json, pickFile, wait } = require('./common');

const API = 'https://api.real-debrid.com/rest/1.0';

function auth(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function call(apiKey, path, { method = 'GET', body } = {}) {
  return json(`${API}${path}`, {
    method,
    headers: {
      ...auth(apiKey),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
}

/**
 * O Real-Debrid aposentou o /torrents/instantAvailability: não há mais como
 * perguntar em lote o que está em cache. Devolvemos vazio e o orquestrador
 * trata todos como "não sei" — ver `cacheCheck: false` no final do arquivo.
 */
async function checkCached() {
  return new Set();
}

const READY = 'downloaded';
const WORKING = ['magnet_conversion', 'queued', 'downloading', 'compressing', 'uploading'];

async function resolveLink(apiKey, infoHash, { season, episode } = {}) {
  const add = await call(apiKey, '/torrents/addMagnet', {
    method: 'POST',
    body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
  });
  if (!add?.id) return null;

  let info = await call(apiKey, `/torrents/info/${add.id}`);

  // O torrent entra sem nenhum arquivo selecionado; sem selectFiles ele nunca
  // sai de "waiting_files_selection" e a lista de links fica vazia.
  if (info.status === 'waiting_files_selection') {
    const wanted = pickFile(
      (info.files || []).map((f) => ({ ...f, path: f.path, size: f.bytes })),
      { season, episode },
    );
    await call(apiKey, `/torrents/selectFiles/${add.id}`, {
      method: 'POST',
      body: new URLSearchParams({ files: wanted ? String(wanted.id) : 'all' }),
    });
    info = await call(apiKey, `/torrents/info/${add.id}`);
  }

  // Já em cache o status vira "downloaded" quase imediatamente. Se ainda
  // estiver baixando, não há o que tocar agora — o play falharia num buffer
  // eterno, então é melhor devolver nada e deixar o usuário escolher outro.
  for (let attempt = 0; attempt < 3 && WORKING.includes(info.status); attempt += 1) {
    await wait(700);
    info = await call(apiKey, `/torrents/info/${add.id}`);
  }
  if (info.status !== READY) {
    console.warn(`[realdebrid] torrent não está em cache (status: ${info.status})`);
    return null;
  }

  // `links` traz só os arquivos selecionados, na ordem dos selecionados —
  // por isso a escolha do arquivo é refeita sobre esse subconjunto.
  const selected = (info.files || []).filter((f) => f.selected);
  const idx = selected.length > 1
    ? selected.indexOf(
        pickFile(selected.map((f) => ({ ...f, path: f.path, size: f.bytes })), { season, episode }),
      )
    : 0;
  const link = (info.links || [])[idx >= 0 ? idx : 0];
  if (!link) return null;

  const unrestricted = await call(apiKey, '/unrestrict/link', {
    method: 'POST',
    body: new URLSearchParams({ link }),
  });
  return unrestricted?.download || null;
}

/**
 * Só ENFILEIRA o download e sai; quem quer o link usa resolveLink.
 * O selectFiles não é opcional: sem ele o torrent fica parado em
 * "waiting_files_selection" para sempre e nada é baixado.
 */
async function enqueue(apiKey, infoHash, { season, episode } = {}) {
  const add = await call(apiKey, '/torrents/addMagnet', {
    method: 'POST',
    body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
  });
  if (!add?.id) return false;

  const info = await call(apiKey, `/torrents/info/${add.id}`);
  if (info.status !== 'waiting_files_selection') return true;

  const wanted = pickFile(
    (info.files || []).map((f) => ({ ...f, path: f.path, size: f.bytes })),
    { season, episode },
  );
  await call(apiKey, `/torrents/selectFiles/${add.id}`, {
    method: 'POST',
    body: new URLSearchParams({ files: wanted ? String(wanted.id) : 'all' }),
  });
  return true;
}

module.exports = {
  id: 'realdebrid',
  label: 'Real-Debrid',
  cacheCheck: false,
  enqueue,
  keyUrl: 'https://real-debrid.com/apitoken',
  checkCached,
  resolveLink,
};
