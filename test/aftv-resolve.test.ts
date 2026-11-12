import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAftvResolver, extractDestination } from '../src/utils/aftv-resolve.js';

// Códigos da AFTVnews resolvidos pelo FlareSolverr (o site barra apps com o
// desafio do Cloudflare desde 2026-11-12).

const DEST = 'https://powermovie.net/abc/manifest.json';

function solver(solution: { url: string; response: string } | null, status = 'ok') {
  const calls: any[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status, message: 'x', solution }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('destino vem do solution.url depois do redirect em JS', async () => {
  const s = solver({ url: DEST, response: '<pre>{"id":"x"}</pre>' });
  const resolver = createAftvResolver({ flaresolverrUrl: 'http://fs/v1', fetchImpl: s.fetchImpl });
  assert.deepEqual(await resolver.resolve('7330456'), { url: DEST });
  assert.equal(s.calls[0].url, 'https://go.aftvnews.com/7330456');
  assert.equal(s.calls[0].cmd, 'request.get');
});

test('código inexistente vira url null', () => {
  assert.deepEqual(
    extractDestination('https://go.aftvnews.com/99999', 'The Short URL you entered does not exist.'),
    { url: null },
  );
});

test('sem redirect seguido, lê o window.location da página', () => {
  assert.deepEqual(
    extractDestination('https://go.aftvnews.com/1', 'window.location = "https://a.example/manifest.json?x=1&amp;y=2";'),
    { url: 'https://a.example/manifest.json?x=1&y=2' },
  );
  assert.equal(extractDestination('https://go.aftvnews.com/1', '<html>nada</html>'), 'unknown');
});

test('resultado fica em cache: o solver roda uma vez por código', async () => {
  const s = solver({ url: DEST, response: '' });
  const resolver = createAftvResolver({ flaresolverrUrl: 'http://fs/v1', fetchImpl: s.fetchImpl });
  await resolver.resolve('7330456');
  await resolver.resolve('7330456');
  assert.equal(s.calls.length, 1);
});

test('falha do solver vira erro', async () => {
  const s = solver(null, 'error');
  const resolver = createAftvResolver({ flaresolverrUrl: 'http://fs/v1', fetchImpl: s.fetchImpl });
  await assert.rejects(resolver.resolve('7330456'), /FlareSolverr/);
});

test('mais de 2 códigos diferentes ao mesmo tempo: o terceiro recebe busy', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl = async () => {
    await gate;
    return new Response(JSON.stringify({ status: 'ok', solution: { url: DEST, response: '' } }));
  };
  const resolver = createAftvResolver({ flaresolverrUrl: 'http://fs/v1', fetchImpl });
  const a = resolver.resolve('111');
  const b = resolver.resolve('222');
  await assert.rejects(resolver.resolve('333'), /busy/);
  release();
  await Promise.all([a, b]);
});
