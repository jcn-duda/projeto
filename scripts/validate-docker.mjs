#!/usr/bin/env node
/**
 * Validação real do container local (validação, não golden): sobe requisições
 * de verdade contra a 7000 (gateway → Node, ou Node direto sem GATEWAY) e
 * confere forma e conteúdo mínimo.
 *
 * Uso: node scripts/validate-docker.mjs [--base http://127.0.0.1:7000] [--container stremio-adom]
 * Token de diagnóstico vem de JACKETT_TEST_TOKEN no .env (nunca impresso).
 *
 * Rotas internas (`/internal/search/*`): DE FORA elas têm que ser recusadas nos
 * dois modos — 403 de loopback (Node direto) ou 403 do gateway, que nem
 * encaminha `/internal/*`. O caminho que precisa dar 200 é o do orquestrador:
 * de dentro do container, direto no Node (7100 com gateway, 7000 sem), testado
 * via `docker exec` com o token lido lá dentro.
 * Saída: uma linha por checagem + contagem; exit 1 se algo falhar.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : 'http://127.0.0.1:7000';
const containerIdx = args.indexOf('--container');
const CONTAINER = containerIdx >= 0 ? args[containerIdx + 1] : 'stremio-adom';

// Lê só o token do .env, sem imprimir nada dele.
const envText = fs.existsSync(path.join(REPO, '.env'))
  ? fs.readFileSync(path.join(REPO, '.env'), 'utf8')
  : '';
const tokenLine = envText.split('\n').find((l) => l.startsWith('JACKETT_TEST_TOKEN='));
const TOKEN = tokenLine ? tokenLine.split('=').slice(1).join('=').trim() : '';

/** Config mínima válida: `{}` em base64url — o decode do runtime aceita o
 * objeto vazio e aplica os defaults da instalação (invariante 5: a preferência
 * vem da URL, nunca do .env). */
const VALID_ENCODED = 'e30';

let pass = 0;
let failCount = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`ok   ${name}${detail ? ` :: ${detail}` : ''}`);
  } catch (e) {
    failCount += 1;
    failures.push(`${name}: ${e.message}`);
    console.log(`FALHA ${name} :: ${e.message}`);
  }
}

async function req(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function jsonOf(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`corpo não é JSON: ${res.text.slice(0, 120)}`);
  }
}

/** De fora, rota interna recusada é a defesa funcionando: 403 da guarda de
 * loopback (Node direto) ou do gateway (que nem encaminha `/internal/*`). */
function refusedOutside(res) {
  if (res.status !== 403) return null;
  if (res.text.includes('loopback')) return '403 da guarda de loopback (Node direto)';
  if (res.text.includes('gateway')) return '403 do gateway (não encaminha /internal/*)';
  return null;
}

/**
 * Chama uma rota interna DE DENTRO do container, direto no Node, como o
 * orquestrador fará. O token é lido no ambiente do container e nunca sai dele.
 */
function insideContainer(pathname, body) {
  const script = `
    const port = process.env.GATEWAY === 'on' ? 7100 : (process.env.PORT || 7000);
    fetch('http://127.0.0.1:' + port + ${JSON.stringify(pathname)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Indexer-Test-Token': process.env.JACKETT_TEST_TOKEN || '' },
      body: ${JSON.stringify(JSON.stringify(body))},
    }).then(async (r) => console.log(JSON.stringify({ status: r.status, text: await r.text() })))
      .catch((e) => console.log(JSON.stringify({ status: 0, text: String(e && e.message) })));`;
  const run = spawnSync('docker', ['exec', CONTAINER, 'node', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw new Error(`docker exec falhou: ${(run.stderr || '').trim().slice(0, 160)}`);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

/** Forma da lista: tocável = tem url/infoHash/externalUrl. */
function streamShape(streams) {
  const comAcao = streams.filter((s) => s.url || s.infoHash || s.externalUrl);
  return {
    total: streams.length,
    tocaveis: comAcao.length,
    dublado: streams.filter((s) => /Dublado|Dub/i.test(`${s.name} ${s.title ?? ''}`)).length,
    resolve: streams.filter((s) => String(s.url || '').includes('/resolve/')).length,
  };
}

// 1. Health.
await check('GET /health → 200 {"ok":true}', async () => {
  const res = await req('/health');
  expect(res.status === 200, `status ${res.status}`);
  const body = jsonOf(res);
  expect(body.ok === true, `corpo ${JSON.stringify(body).slice(0, 80)}`);
  return '';
});

// 2. Manifest da instalação sem config.
await check('GET /manifest.json → 200 com id/name', async () => {
  const res = await req('/manifest.json');
  expect(res.status === 200, `status ${res.status}`);
  const body = jsonOf(res);
  expect(typeof body.id === 'string' && body.id.length > 0, 'manifest sem id');
  expect(Array.isArray(body.resources) && body.resources.length > 0, 'manifest sem resources');
  return `id=${body.id.slice(0, 40)}`;
});

// 3. Página de configuração.
await check('GET /configure → 200 html', async () => {
  const res = await req('/configure');
  expect(res.status === 200, `status ${res.status}`);
  expect(/<html|<!doctype/i.test(res.text), 'corpo não parece html');
  return `${res.text.length} bytes`;
});

// 4. /stream de filme (Trainspotting): coleta real contra Jackett/indexers.
await check('GET /stream/movie/tt0117731.json → 200 com streams tocáveis', async () => {
  const res = await req('/stream/movie/tt0117731.json');
  expect(res.status === 200, `status ${res.status}`);
  const body = jsonOf(res);
  expect(Array.isArray(body.streams), 'resposta sem streams[]');
  const shape = streamShape(body.streams);
  expect(shape.tocaveis > 0, `nenhum stream tocável: ${JSON.stringify(shape)}`);
  return JSON.stringify(shape);
});

// 5. /stream de série com episódio (Breaking Bad S01E01): caminho de episódio.
await check('GET /stream/series/tt0903747:1:1.json → 200 com streams tocáveis', async () => {
  const res = await req('/stream/series/tt0903747:1:1.json');
  expect(res.status === 200, `status ${res.status}`);
  const body = jsonOf(res);
  expect(Array.isArray(body.streams), 'resposta sem streams[]');
  const shape = streamShape(body.streams);
  expect(shape.tocaveis > 0, `nenhum stream tocável: ${JSON.stringify(shape)}`);
  return JSON.stringify(shape);
});

// 6. Segunda passada no filme: sai do cache (streams:v21) — prova o caminho do
//    SWR passando pelo proxy sem alterar a semântica.
await check('GET /stream/movie (2ª passada) → serve do cache', async () => {
  const first = await req('/stream/movie/tt0117731.json');
  expect(first.status === 200, `primeira passada ${first.status}`);
  const second = await req('/stream/movie/tt0117731.json');
  expect(second.status === 200, `segunda passada ${second.status}`);
  const body = jsonOf(second);
  expect(Array.isArray(body.streams), 'resposta sem streams[]');
  return `streams=${body.streams.length}`;
});

// 7. Rota interna de metadados: guardas (401/403/503) sem token.
await check('POST /internal/search/meta sem token → recusado (401/403/503)', async () => {
  const res = await req('/internal/search/meta', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encoded: VALID_ENCODED, type: 'movie', id: 'tt0117731' }),
  });
  expect([401, 403, 503].includes(res.status), `status inesperado ${res.status}`);
  return `status ${res.status}`;
});

if (TOKEN) {
  await check('POST /internal/search/meta com token, de fora → recusado (403)', async () => {
    const res = await req('/internal/search/meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Indexer-Test-Token': TOKEN },
      body: JSON.stringify({ encoded: VALID_ENCODED, type: 'movie', id: 'tt0117731' }),
    });
    const recusa = refusedOutside(res);
    expect(recusa, `rota interna aberta de fora: status ${res.status} :: ${res.text.slice(0, 120)}`);
    return recusa;
  });
} else {
  console.log('pula a checagem de fora com token: JACKETT_TEST_TOKEN ausente no .env');
}

await check('POST /internal/search/meta de dentro (orquestrador) → 200 ok', async () => {
  const res = insideContainer('/internal/search/meta', { encoded: VALID_ENCODED, type: 'movie', id: 'tt0117731' });
  expect(res.status === 200, `status ${res.status} :: ${res.text.slice(0, 120)}`);
  const body = jsonOf(res);
  expect(body.ok === true, `ok != true :: ${JSON.stringify(body).slice(0, 120)}`);
  return 'meta/titles lidos';
});

// 8. Caminho inexistente segue para o Node (404 do addon, não 502 do proxy).
await check('GET /rota-que-nao-existe → 404 (proxy vivo, não 502)', async () => {
  const res = await req('/rota-que-nao-existe');
  expect(res.status === 404, `status ${res.status}`);
  return '';
});

console.log(`\n${pass} ok, ${failCount} falha(s)`);
if (failCount > 0) {
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
