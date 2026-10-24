import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../resolvers/profiles/vacatorrent.js';

// Instâncias e respostas sintéticas: sem servidor, rede externa ou cache real.
const site = 'https://vaqueirofilmes.com';
const movie = (id: number) => ({ title: `Coringa ${id}`, link: `${site}/pt/movie/${id}/`, type: 'Filme' });
const moviePage = (id: number) => `<a href="/movie-links/${id}/">Download</a>`;
const download = (id: number) => `<h2>Download</h2><p>1080p Português | Inglês 2.54 GB</p><a href="https://systemtech.space/enc/go.php?id=${id}">Baixar</a>`;
const online = '<h2>Veja Online</h2><a href="https://player.example/embed/40814">Assistir</a>';
const wpError = '<html><title>WordPress › Erro</title><body id="error-page"><div class="wp-die-message">Erro crítico</div></body></html>';
const series = { title: 'Série Vaca', link: `${site}/pt/serie/vaca/`, type: 'Série' };
const seriesPage = `<a data-u="${Buffer.from(`${site}/pt/season-internal/?show=60009`).toString('base64')}">Temporadas</a>`;
const cards = '<a class="sa-card" href="/temporada-1/">1ª Temporada</a><a class="sa-card" href="/temporada-2/">2ª Temporada</a>';

for (const bad of ['nan', '{"success":false}', wpError]) {
  test(`Vaca: AJAX inválido não confirma saúde nem grava cache (${bad.slice(0, 20)})`, async (t) => {
    const vaca = createResolver();
    const success = t.mock.method(vaca.siteSelector, 'noteSuccess');
    let calls = 0;
    let healthy = false;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(healthy ? '[]' : bad); });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => vaca.searchPosts('Coringa')));
    assert.ok(results.every((r) => r.status === 'rejected'), 'falha precisa atravessar o cache/coalescing');
    assert.equal(calls, 1, 'buscas concorrentes compartilham a tentativa');
    assert.equal(success.mock.callCount(), 0);
    assert.equal(vaca.searchCache.size, 0);
    assert.equal(vaca.inFlight.size, 0);
    healthy = true;
    assert.deepEqual(await vaca.searchPosts('Coringa'), []);
    assert.equal(success.mock.callCount(), 1, '[] válido prova resposta da busca');
    await vaca.searchPosts('Coringa');
    assert.equal(calls, 2, '[] válido usa o cache; falha anterior não o envenenou');
  });
}

for (const stage of ['post', 'links']) {
  for (const failure of ['http', 'wp']) {
    test(`Vaca: falha ${failure} em ${stage} recupera na próxima busca`, async (t) => {
      const vaca = createResolver();
      let healthy = false;
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async (input: string) => {
        calls++;
        const path = new URL(input).pathname;
        if (path.includes('admin-ajax')) return Response.json([movie(60009)]);
        if ((stage === 'post' ? path.includes('/movie/') : path.includes('/movie-links/')) && !healthy) {
          return new Response(failure === 'wp' ? wpError : 'Indisponível', { status: failure === 'wp' ? 200 : 503 });
        }
        if (path.includes('/movie/')) return new Response(moviePage(60009));
        if (path.includes('/movie-links/')) return new Response(download(60009));
        throw new Error(`fetch inesperado: ${path}`);
      });
      await assert.rejects(vaca.searchPosts('Coringa'), /vacatorrent:/);
      assert.equal(vaca.postCache.size, 0);
      assert.equal(vaca.searchCache.size, 0);
      healthy = true;
      assert.equal((await vaca.searchPosts('Coringa')).length, 1);
      const afterRecovery = calls;
      await vaca.searchPosts('Coringa');
      assert.equal(calls, afterRecovery, 'sucesso completo continua cacheado');
      assert.equal(vaca.inFlight.size, 0);
    });
  }
}

test('Vaca: post bom sobrevive à falha do vizinho sem congelar busca parcial', async (t) => {
  const vaca = createResolver();
  let healthy = false;
  let goodPostFetches = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const path = new URL(input).pathname;
    if (path.includes('admin-ajax')) return Response.json([movie(60009), movie(40814)]);
    if (path === '/pt/movie/40814/' && !healthy) return new Response('Indisponível', { status: 503 });
    if (path === '/pt/movie/60009/') goodPostFetches++;
    if (path.includes('/movie/')) return new Response(moviePage(path.includes('60009') ? 60009 : 40814));
    if (path.includes('/movie-links/')) return new Response(download(path.includes('60009') ? 60009 : 40814));
    throw new Error(`fetch inesperado: ${path}`);
  });
  const first = await Promise.all(Array.from({ length: 8 }, () => vaca.searchPosts('Coringa')));
  assert.ok(first.every((items) => items.length === 1), 'todos recebem o sucesso parcial coalescido');
  assert.equal(vaca.searchCache.size, 0, 'parcial não recebe TTL completo');
  healthy = true;
  assert.equal((await vaca.searchPosts('Coringa')).length, 2);
  assert.equal(goodPostFetches, 1, 'cache do post saudável é preservado');
});

for (const stage of ['post', 'internal', 'all-cards', 'one-card']) {
  test(`Vaca: falha de série em ${stage} não congela temporadas vazias/incompletas`, async (t) => {
    const vaca = createResolver();
    let healthy = false;
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const path = new URL(input).pathname;
      if (path.includes('admin-ajax')) return Response.json([series]);
      const fail = stage === 'post' ? path.includes('/serie/')
        : stage === 'internal' ? path.includes('season-internal')
          : stage === 'all-cards' ? path.includes('temporada-') : path.includes('temporada-2');
      if (!healthy && fail) return new Response('Indisponível', { status: 503 });
      if (path.includes('/serie/')) return new Response(seriesPage);
      if (path.includes('season-internal')) return new Response(cards);
      if (path.includes('temporada-')) return new Response(download(path.includes('-1') ? 1 : 2));
      throw new Error(`fetch inesperado: ${path}`);
    });
    if (stage === 'one-card') {
      const first = await vaca.searchPosts('Série Vaca');
      assert.equal(first.length, 1, 'temporada saudável permanece disponível');
      assert.ok(first[0].link.url.endsWith('id=1'));
    } else await assert.rejects(vaca.searchPosts('Série Vaca'), /vacatorrent:/);
    assert.equal(vaca.searchCache.size, 0);
    assert.equal(vaca.postCache.size, 0, 'agregado da série incompleta não recebe TTL cheio');
    healthy = true;
    const recovered = await vaca.searchPosts('Série Vaca');
    assert.equal(recovered.length, 2);
    assert.deepEqual(recovered.map((item) => new URL(item.link.url).searchParams.get('id')), ['1', '2']);
    assert.equal(vaca.inFlight.size, 0);
  });
}

test('Vaca: Veja Online é ausência real de download, não torrent nem falha', async (t) => {
  const vaca = createResolver();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls++;
    const path = new URL(input).pathname;
    if (path.includes('admin-ajax')) return Response.json([movie(40814)]);
    if (path.includes('/movie/')) return new Response(moviePage(40814));
    if (path.includes('/movie-links/')) return new Response(online);
    throw new Error(`não deve visitar player: ${path}`);
  });
  assert.deepEqual(await vaca.searchPosts('Coringa'), []);
  await vaca.searchPosts('Coringa');
  assert.equal(calls, 3, 'ausência real pode ser cacheada');
  assert.equal(vaca.searchCache.size, 1);
});

test('Vaca: temporada não publicada continua sendo vazio válido', async (t) => {
  const vaca = createResolver();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    calls++;
    const path = new URL(input).pathname;
    if (path.includes('admin-ajax')) return Response.json([series]);
    if (path.includes('/serie/')) return new Response(seriesPage);
    if (path.includes('season-internal')) return new Response(cards);
    throw new Error(`temporada fora do pedido: ${path}`);
  });
  assert.deepEqual(await vaca.searchPosts('Série Vaca S03'), []);
  await vaca.searchPosts('Série Vaca S03');
  assert.equal(calls, 3);
});
