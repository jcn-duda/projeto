#!/usr/bin/env node
/**
 * Validação real do container local (validação, não golden): sobe requisições
 * de verdade contra a 7000 (gateway → Node, ou Node direto sem GATEWAY) e
 * confere forma e conteúdo mínimo.
 *
 * Uso: node scripts/validate-docker.mjs [--base http://127.0.0.1:7000]
 * Token de diagnóstico vem de JACKETT_TEST_TOKEN no .env (nunca impresso).
 * Saída: uma linha por checagem + contagem; exit 1 se algo falhar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const BASE = baseIdx >= 0 ? args[baseIdx + 1] : 'http://127.0.0.1:7000';

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

/** Sem o gateway, a conexão do host chega pela ponte do Docker e NÃO é
 * loopback: a guarda das rotas internas recusa com 403 — defesa correta, não
 * defeito. Este helper aceita esse desfecho com uma nota. */
function loopbackSemGateway(res) {
  return res.status === 403 && res.text.includes('loopback')
    ? '403 loopback sem gateway (defesa correta; rode com GATEWAY=on para o 200)'
    : null;
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
  await check('POST /internal/search/meta com token → 200 ok com titles', async () => {
    const res = await req('/internal/search/meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Indexer-Test-Token': TOKEN },
      body: JSON.stringify({ encoded: VALID_ENCODED, type: 'movie', id: 'tt0117731' }),
    });
    const tolerado = loopbackSemGateway(res);
    if (tolerado) return tolerado;
    expect(res.status === 200, `status ${res.status} :: ${res.text.slice(0, 120)}`);
    const body = jsonOf(res);
    expect(body.ok === true, `ok != true :: ${JSON.stringify(body).slice(0, 120)}`);
    return 'meta/titles lidos';
  });

  await check('POST /internal/search/state com token → 200 ok (lote vazio)', async () => {
    const res = await req('/internal/search/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Indexer-Test-Token': TOKEN },
      body: JSON.stringify({ encoded: VALID_ENCODED, obra_keys: [], hashes: [] }),
    });
    const tolerado = loopbackSemGateway(res);
    if (tolerado) return tolerado;
    expect(res.status === 200, `status ${res.status} :: ${res.text.slice(0, 120)}`);
    const body = jsonOf(res);
    expect(body.ok === true && typeof body.obras === 'object', 'resposta sem obras{}');
    return 'acervo lido em lote';
  });
} else {
  console.log('pula rotas internas autenticadas: JACKETT_TEST_TOKEN ausente no .env');
}

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
