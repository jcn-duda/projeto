// Fase 1: parser real do /torrentStatus de cada adaptador. Cada serviço tem o
// seu formato (e o seu envelope), e a única forma honesta de cobrir a tradução
// hash + estado é alimentar o adaptador com o shape real da API — com fetch
// dublado, sem rede nenhuma. O Premiumize ganha as regras novas da cascata de
// hash e do `stalled`; os outros quatro só ganham cobertura do que já faziam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import * as metrics from '../src/utils/metrics.js';

process.env.CACHE_PERSIST = 'false';

type StatusRow = { state: 'ready' | 'downloading' | 'dead' | 'unknown'; stalled?: boolean; id?: any };

const btih = (h: string) => `magnet:?xt=urn:btih:${h}`;

/**
 * Dublê do fetch que responde sempre `body` (é o `.json()` que os adaptadores
 * consomem). `AbortSignal.timeout` precisa virar no-op, senão o timer real
 * prende o teste no timeout do debrid (o mesmo padrão do debrid-status.test).
 */
function stubFetch(body: unknown) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

async function statusOf(id: string, body: unknown): Promise<Record<string, StatusRow>> {
  const adapter = debrid.BY_ID.get(id);
  if (!adapter || typeof adapter.torrentStatus !== 'function') {
    throw new Error(`adaptador ${id} sem torrentStatus`);
  }
  const restore = stubFetch(body);
  try {
    return await adapter.torrentStatus('chave-de-teste', []);
  } finally {
    restore();
  }
}

const stalledAfter = (name: string) => metrics.snapshot().counters[name] || 0;

// --- Premiumize: cascata do hash ------------------------------------------

test('premiumize: cascata do hash — src btih vence, depois name cru, depois hash/info_hash', async () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const H3 = 'c'.repeat(40);
  const H4 = 'd'.repeat(40);
  const out = await statusOf('premiumize', {
    status: 'success',
    transfers: [
      // 1) src com btih (em MAIÚSCULO, como o magnet real chega)
      { id: 1, status: 'finished', src: btih(H1.toUpperCase()), name: 'Nome qualquer' },
      // 2) sem src, mas o nome É o hash v1 cru
      { id: 2, status: 'running', src: '', name: H2, progress: 0.5 },
      // 3) campo `hash` direto
      { id: 3, status: 'running', src: '', name: 'Meu Release 1080p', hash: H3, progress: 0.5 },
      // 4) campo `info_hash` como alternativa ao `hash`
      { id: 4, status: 'running', src: '', name: 'Outra Release', info_hash: H4.toUpperCase(), progress: 0.5 },
    ],
  });
  assert.deepEqual(Object.keys(out).sort(), [H1, H2, H3, H4].sort());
  assert.equal(out[H1].state, 'ready', 'src btih continua sendo a fonte primária');
});

test('premiumize: running com progresso 0/ausente e mensagem de 0 bytes/peers marca stalled', async () => {
  const a = '1'.repeat(40);
  const b = '2'.repeat(40);
  const c = '3'.repeat(40);
  const d = '4'.repeat(40);
  const e = '5'.repeat(40);
  const f = '6'.repeat(40);
  const g = '7'.repeat(40);
  const out = await statusOf('premiumize', {
    status: 'success',
    transfers: [
      { id: 1, status: 'running', src: btih(a), progress: 0, message: '0 Bytes of 0 Bytes' },
      // progresso ausente (campo não enviado)
      { id: 2, status: 'running', src: btih(b), message: 'Downloading from 0 peer(s)' },
      // progresso > 0 descarta o stall, mesmo com a mensagem de 0 bytes
      { id: 3, status: 'running', src: btih(c), progress: 0.42, message: '0 Bytes of 0 Bytes' },
      // mensagem sem o padrão de parada (baixando de verdade)
      { id: 4, status: 'running', src: btih(d), progress: 0, message: 'Downloading 3.2 MB from 5 peers' },
      // queued não é running: nunca stalled
      { id: 5, status: 'queued', src: btih(e), progress: 0, message: '0 Bytes of 0 Bytes' },
      { id: 6, status: 'finished', src: btih(f), message: '0 Bytes of 0 Bytes' },
      { id: 7, status: 'error', src: btih(g), message: '0 Bytes of 0 Bytes' },
    ],
  });
  assert.equal(out[a].state, 'downloading');
  assert.equal(out[a].stalled, true, 'progress 0 + mensagem de parada => stalled');
  assert.equal(out[b].stalled, true, 'progress ausente + "from 0 peer" => stalled');
  assert.equal(out[c].stalled, false, 'progress > 0 nunca é stalled');
  assert.equal(out[d].stalled, false, 'mensagem de avanço não é stalled');
  assert.equal(out[e].stalled, false, 'queued não usa o campo');
  assert.equal(out[e].state, 'downloading');
  assert.equal(out[f].stalled, false, 'pronto não é stalled');
  assert.equal(out[f].state, 'ready');
  assert.equal(out[g].state, 'dead');
  assert.equal(out[g].stalled, false);
});

test('premiumize: transferência sem hash nenhum é descartada e contada em debrid.pm.status.unmatched', async () => {
  const before = stalledAfter('debrid.pm.status.unmatched');
  const out = await statusOf('premiumize', {
    status: 'success',
    transfers: [
      { id: 1, status: 'running', src: btih('a'.repeat(40)), progress: 0.5 },
      // sem src, nome que não é hash nem tem hash, sem campo hash
      { id: 2, status: 'running', src: '', name: 'Sem hash nenhum', progress: 0.5 },
      { id: 3, status: 'running', src: '', name: '', progress: 0.5 },
    ],
  });
  const delta = metrics.snapshot().counters['debrid.pm.status.unmatched'] - before;
  assert.equal(Object.keys(out).length, 1, 'só a transferência com hash entra no mapa');
  assert.equal(delta, 2, 'as duas órfãs contam como unmatched');
});

// --- AllDebrid ------------------------------------------------------------

test('alldebrid: parser do /magnet/status mapeia ready, ativo e morto', async () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const d = 'd'.repeat(40);
  const out = await statusOf('alldebrid', {
    status: 'success',
    data: {
      magnets: [
        { id: 1, hash: a.toUpperCase(), ready: true },
        { id: 2, hash: b, status: 'queued' },
        { id: 3, hash: c, status: 'error' },
        // estado terminal típico da message de peer morto
        { id: 4, hash: d, status: 'No peer after 30 minutes' },
        // sem hash não pode indexar o lote
        { id: 5, status: 'ready' },
      ],
    },
  });
  assert.equal(out[a].state, 'ready');
  assert.equal(out[a].id, 1);
  assert.equal(out[b].state, 'downloading');
  assert.equal(out[c].state, 'dead');
  assert.equal(out[d].state, 'dead');
  assert.equal(out['5'], undefined, 'magnet sem hash é ignorado');
});

// --- Real-Debrid ----------------------------------------------------------

test('realdebrid: parser do /torrents/list cobre downloaded, downloading e magnet_error', async () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const d = 'd'.repeat(40);
  const out = await statusOf('realdebrid', [
    { id: 1, hash: a.toUpperCase(), status: 'downloaded' },
    { id: 2, hash: b, status: 'downloading' },
    { id: 3, hash: c, status: 'magnet_error' },
    { id: 4, hash: d, status: 'waiting_files_selection' },
    { id: 5, filename: 'sem-hash' },
  ]);
  assert.equal(out[a].state, 'ready');
  assert.equal(out[b].state, 'downloading');
  assert.equal(out[c].state, 'dead');
  assert.equal(out[d].state, 'downloading', 'waiting_files_selection conta como ativo');
  assert.equal(out['5'], undefined, 'item sem hash é ignorado');
});

// --- TorBox ---------------------------------------------------------------

test('torbox: parser do /torrents/mylist distingue pronto, baixando, quebrado e parado', async () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const d = 'd'.repeat(40);
  const e = 'e'.repeat(40);
  const out = await statusOf('torbox', {
    success: true,
    data: [
      { id: 1, hash: a.toUpperCase(), download_finished: true },
      { id: 2, hash: b, download_state: 'downloading' },
      { id: 3, hash: c, download_state: 'error' },
      // `stalled` é estado NATIVO da API TorBox (o download não avança mas
      // ainda não errou): entra como downloading + stalled, não como dead.
      { id: 4, hash: d, download_state: 'stalled' },
      // Estado terminal vence arquivo parcial ainda presente.
      { id: 5, hash: e, download_state: 'failed', download_present: true },
      { id: 6, download_state: 'downloading' }, // sem hash
    ],
  });
  assert.equal(out[a].state, 'ready');
  assert.equal(out[b].state, 'downloading');
  assert.equal(out[c].state, 'dead');
  assert.equal(out[d].state, 'downloading', 'stalled nativo não é dead na TorBox');
  assert.equal(out[d].stalled, true, 'campo objetivo da API marcado para o recheck');
  assert.equal(out[e].state, 'dead', 'falha terminal não vira ready por arquivo parcial');
  assert.equal(out['5'], undefined);
});

test('alldebrid/realdebrid/debridlink não inventam stalled: sem sinal objetivo, só ready/downloading/dead', async () => {
  // Esses três serviços não expõem um estado de parada distinto do erro: o
  // código NÃO deve marcar stalled onde a API não tem campo que o prove.
  const ad = await statusOf('alldebrid', {
    status: 'success',
    data: { magnets: [{ id: 1, hash: 'b'.repeat(40), status: 'downloading' }] },
  });
  const rd = await statusOf('realdebrid', [
    { id: 1, hash: 'c'.repeat(40), status: 'downloading' },
  ]);
  const dl = await statusOf('debridlink', {
    success: true,
    value: [{ id: 1, hash: 'd'.repeat(40), downloadPercent: 42, status: 'downloading' }],
  });
  for (const out of [ad, rd, dl]) {
    const row = Object.values(out)[0];
    assert.equal(row!.stalled, undefined, 'sem evidência no campo, stalled nunca é afirmado');
    assert.equal(row!.id, 1, 'id reconhecido');
  }
});

// --- Debrid-Link ----------------------------------------------------------

test('debridlink: parser do /seedbox/list usa downloadPercent e status', async () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);
  const out = await statusOf('debridlink', {
    success: true,
    value: [
      { id: 1, hash: a.toUpperCase(), downloadPercent: 100, status: 'downloading' },
      { id: 2, hash: b, downloadPercent: 87, status: 'downloading' },
      { id: 3, hash: c, downloadPercent: 0, status: 'error' },
      { id: 4, downloadPercent: 10 }, // sem hash
    ],
  });
  assert.equal(out[a].state, 'ready', 'downloadPercent >= 100 é pronto');
  assert.equal(out[b].state, 'downloading', 'default do serviço é baixando');
  assert.equal(out[c].state, 'dead');
  assert.equal(out['4'], undefined);
});
