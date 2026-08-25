// `NoVideoError` na fronteira do adaptador Real-Debrid.
//
// O RD é o único que chama o `pickFile` FORA do caminho de play: no
// `waiting_files_selection`, tanto no `resolveLink` quanto no `enqueue`, onde o
// retorno guiava um `files: wanted ? id : 'all'`. Quando o `pickFile` passou a
// LANÇAR em listagem sem vídeo (`98cd842`), esses dois sites herdaram a exceção
// sem tratamento — e o torrent já tinha sido ADICIONADO à conta, ficando preso
// em `waiting_files_selection` para sempre, porque nada seleciona arquivo
// depois dali.
//
// Estes testes cobrem a fronteira com o shape real da API do RD e fetch
// dublado, sem rede: quem prova que não tem vídeo é removido da conta; quem
// tem vídeo segue o caminho normal; e listagem VAZIA (transferência fria)
// espera o catálogo sem selecionar tudo nem condenar o torrent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as realdebrid from '../src/debrid/realdebrid.js';
import { isNoVideoError } from '../src/debrid/common.js';

const HASH = 'e'.repeat(40);

/**
 * Dublê de fetch por ROTA: cada chamada do adaptador é registrada em `calls`
 * (método + caminho), para o teste afirmar o que foi à rede — é assim que se
 * prova a remoção do torrent, que não tem retorno visível.
 * `AbortSignal.timeout` vira no-op, senão o timer real prende o teste no
 * timeout do debrid (mesmo padrão do debrid-torrent-status.test).
 */
function stubRd(files: any[]) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  AbortSignal.timeout = () => new AbortController().signal;
  // `wait()` usa timer unref para não segurar o addon. No node:test, sem um
  // handle ativo, isso cancela a promise antes do próximo poll; o dublê avança
  // o relógio sem transformar o contrato do adaptador em espera real.
  globalThis.setTimeout = ((callback: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    queueMicrotask(() => callback(...args));
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = (async (url: any, init: any) => {
    const path = String(url).replace('https://api.real-debrid.com/rest/1.0', '');
    calls.push(`${init?.method || 'GET'} ${path}`);
    let body: any = {};
    if (path === '/torrents/addMagnet') body = { id: 'RD1' };
    else if (path.startsWith('/torrents/info/')) body = { status: 'waiting_files_selection', files };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

const file = (id: number, path: string) => ({ id, path, bytes: 1024 ** 3 });

function stubRdPoll(statuses: Array<{ status: string; files?: any[]; links?: string[] }>) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const realSetTimeout = globalThis.setTimeout;
  let infoCall = 0;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, _ms?: number, ...args: any[]) => {
    queueMicrotask(() => callback(...args));
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = (async (url: any, init: any) => {
    const path = String(url).replace('https://api.real-debrid.com/rest/1.0', '');
    calls.push(`${init?.method || 'GET'} ${path}`);
    let body: any = {};
    if (path === '/torrents/addMagnet') body = { id: 'RD1' };
    else if (path.startsWith('/torrents/info/')) body = statuses[Math.min(infoCall++, statuses.length - 1)];
    else if (path === '/unrestrict/link') body = { download: 'https://cdn.example/video.mkv' };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

test('enqueue: listagem só com .rar recusa, remove o torrent e NÃO seleciona arquivo', async () => {
  const rd = stubRd([file(1, 'pack/parte.rar'), file(2, 'pack/parte.r00')]);
  try {
    const ok = await realdebrid.enqueue('chave-de-teste', HASH, { season: null, episode: null });
    assert.equal(ok, false, 'false é o contrato que o chamador entende: conta refused, loga "não aceitou"');
    assert.ok(
      rd.calls.some((c) => c === 'DELETE /torrents/delete/RD1'),
      'o torrent adicionado precisa sair da conta, senão fica preso em waiting_files_selection',
    );
    assert.ok(
      !rd.calls.some((c) => c.includes('/torrents/selectFiles/')),
      'sem vídeo não se seleciona nada — o files: "all" antigo baixava o pack de .rar inteiro',
    );
  } finally {
    rd.restore();
  }
});

test('enqueue: waiting vazio até o teto recusa sem selecionar nem remover', async () => {
  // Listagem vazia não é prova de ausência de vídeo. Esperamos o catálogo, mas
  // não mandamos `all` nem removemos/condenamos o torrent sem essa prova.
  const rd = stubRd([]);
  try {
    const ok = await realdebrid.enqueue('chave-de-teste', HASH, { season: null, episode: null });
    assert.equal(ok, false);
    assert.ok(!rd.calls.some((c) => c.includes('/torrents/selectFiles/')), 'snapshot vazio não seleciona tudo');
    assert.ok(!rd.calls.some((c) => c.startsWith('DELETE')), 'nada a remover: não houve prova');
  } finally {
    rd.restore();
  }
});

test('enqueue: listagem com vídeo segue o caminho normal', async () => {
  const rd = stubRd([file(1, 'Serie S02E01 1080p.mkv')]);
  try {
    const ok = await realdebrid.enqueue('chave-de-teste', HASH, { season: 2, episode: 1 });
    assert.equal(ok, true);
    assert.ok(rd.calls.some((c) => c.includes('/torrents/selectFiles/')));
    assert.ok(!rd.calls.some((c) => c.startsWith('DELETE')));
  } finally {
    rd.restore();
  }
});

test('resolveLink: sem vídeo remove o torrent e DEIXA o NoVideoError subir', async () => {
  // O erro precisa chegar ao /resolve — é lá que o hash é condenado no banco de
  // magnets. Engolir aqui devolveria null, que hoje não condena nada.
  const rd = stubRd([file(1, 'pack/parte.rar')]);
  try {
    await assert.rejects(
      () => realdebrid.resolveLink('chave-de-teste', HASH, { season: null, episode: null }),
      (err: any) => isNoVideoError(err),
      'a prova determinística tem que chegar ao /resolve',
    );
    assert.ok(
      rd.calls.some((c) => c === 'DELETE /torrents/delete/RD1'),
      'o torrent sai da conta mesmo com o erro subindo',
    );
  } finally {
    rd.restore();
  }
});

test('resolveLink: seleciona no poll tardio magnet_conversion → queued → waiting → downloaded', async () => {
  const selected = { ...file(7, 'Filme 1080p.mkv'), selected: 1 };
  const rd = stubRdPoll([
    { status: 'magnet_conversion' },
    { status: 'queued' },
    { status: 'waiting_files_selection', files: [selected] },
    { status: 'downloaded', files: [selected], links: ['https://rd.example/link'] },
  ]);
  try {
    const link = await realdebrid.resolveLink('chave-de-teste', HASH, {});
    assert.equal(link, 'https://cdn.example/video.mkv');
    assert.equal(rd.calls.filter((call) => call === 'POST /torrents/selectFiles/RD1').length, 1);
  } finally {
    rd.restore();
  }
});

test('resolveLink: waiting vazio espera catálogo e seleciona uma única vez quando há vídeo', async () => {
  const selected = { ...file(9, 'Filme 1080p.mkv'), selected: 1 };
  const rd = stubRdPoll([
    { status: 'waiting_files_selection', files: [] },
    { status: 'waiting_files_selection', files: [selected] },
    { status: 'downloaded', files: [selected], links: ['https://rd.example/link'] },
  ]);
  try {
    assert.equal(await realdebrid.resolveLink('chave-de-teste', HASH, {}), 'https://cdn.example/video.mkv');
    assert.equal(rd.calls.filter((call) => call === 'POST /torrents/selectFiles/RD1').length, 1);
  } finally {
    rd.restore();
  }
});

test('resolveLink: waiting vazio até o teto retorna null sem selecionar ou remover', async () => {
  const rd = stubRdPoll([{ status: 'waiting_files_selection', files: [] }]);
  try {
    assert.equal(await realdebrid.resolveLink('chave-de-teste', HASH, {}), null);
    assert.equal(rd.calls.filter((call) => call.includes('/torrents/selectFiles/')).length, 0);
    assert.equal(rd.calls.filter((call) => call.startsWith('DELETE')).length, 0);
  } finally {
    rd.restore();
  }
});

test('enqueue: espera a seleção tardia e não declara sucesso se ela não vier', async () => {
  const selected = file(8, 'Serie S01E01.mkv');
  const rd = stubRdPoll([
    { status: 'magnet_conversion' },
    { status: 'waiting_files_selection', files: [selected] },
    { status: 'downloaded', files: [{ ...selected, selected: 1 }] },
  ]);
  try {
    assert.equal(await realdebrid.enqueue('chave-de-teste', HASH, { season: 1, episode: 1 }), true);
    assert.equal(rd.calls.filter((call) => call === 'POST /torrents/selectFiles/RD1').length, 1);
  } finally {
    rd.restore();
  }

  const alreadySelected = stubRdPoll([{ status: 'downloading', files: [{ ...selected, selected: 1 }] }]);
  try {
    assert.equal(await realdebrid.enqueue('chave-de-teste', HASH), true, 'arquivo já selecionado é evidência objetiva');
    assert.equal(alreadySelected.calls.filter((call) => call.includes('/torrents/selectFiles/')).length, 0);
  } finally {
    alreadySelected.restore();
  }

  const notSelected = stubRdPoll([{ status: 'magnet_conversion' }, { status: 'queued' }]);
  try {
    assert.equal(await realdebrid.enqueue('chave-de-teste', HASH), false);
    assert.equal(notSelected.calls.filter((call) => call.includes('/torrents/selectFiles/')).length, 0);
  } finally {
    notSelected.restore();
  }
});
