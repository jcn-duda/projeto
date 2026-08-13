#!/usr/bin/env node
/**
 * Smoke test do addon rodando. Não sobe servidor: aponta para um que já está
 * de pé, porque metade do que interessa (Jackett, TMDB, debrid) depende de
 * rede e do .env real.
 *
 *   node scripts/smoke.js [baseUrl] [imdbId...]
 *   npm run smoke
 */

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');

// Títulos com nome pt-BR diferente do original — é o caso que exercita a busca
// dupla (EN para indexers globais, PT para os BR).
const TITLES = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      ['movie', 'tt7286456', 'Coringa / Joker'],
      ['movie', 'tt0111161', 'Um Sonho de Liberdade / Shawshank'],
      ['series', 'tt0903747:1:1', 'Breaking Bad S01E01'],
    ].map((t) => t.join('|'));

let failures = 0;
// Em modo demo não existe fonte BR nenhuma; cobrar isso seria falso negativo.
let isDemo = false;

function ok(label, pass, detail) {
  if (!pass) failures += 1;
  console.log(`${pass ? '  ok  ' : ' FALHA'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, timeout = 20000) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeout) });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  // `max-age=0` é como o addon avisa "esta lista está incompleta, pergunte de
  // novo" — é o mesmo sinal que faz o cliente Stremio não fixar uma lista sem
  // as fontes BR. Aqui ele diz quando parar de repetir a chamada.
  const maxAge = Number(String(res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] ?? 0);
  return { status: res.status, body, ms: Date.now() - started, complete: maxAge > 0 };
}

async function checkRoutes() {
  console.log('\n── Rotas ────────────────────────────────');

  const health = await get('/health');
  ok('/health', health.status === 200 && health.body?.ok === true);

  const manifest = await get('/manifest.json');
  ok('/manifest.json', manifest.status === 200, `nome: ${manifest.body?.name}`);
  ok('manifest configurável', manifest.body?.behaviorHints?.configurable === true);

  const page = await get('/configure');
  // O <h1> vem com atributos (ex.: <h1 id="addonName">) e o nome é injetado
  // via JS — checar a tag, não o texto.
  ok('/configure', page.status === 200 && /<h1[ >]/.test(String(page.body)));

  const defaults = await get('/defaults.json');
  ok('/defaults.json', defaults.status === 200);
  isDemo = (defaults.body?.providers || []).includes('demo');
  if (isDemo) console.log('  nota  instância em modo DEMO: checagens de fonte BR desligadas');
  // Regressão específica: a página é pública, a chave do operador não pode sair.
  ok('não vaza DEBRID_API_KEY', defaults.body?.debridApiKey === '');
  ok(
    'lista de debrids',
    Array.isArray(defaults.body?.services) && defaults.body.services.length > 0,
    (defaults.body?.services || []).map((s) => s.id).join(', '),
  );

  const bogus = await get('/naoehumaconfig/manifest.json');
  ok('segmento inválido → 404', bogus.status === 404, `recebido ${bogus.status}`);
}

function inspect(streams) {
  const titles = streams.map((s) => String(s.title || ''));
  return {
    total: streams.length,
    // As fontes BR são reconhecíveis pelo indexer no rodapé do título (a 2ª
    // linha, formato "👤 seeds 💾 tamanho ⚙️ Indexer ..."), ou pelo rótulo
    // antigo "bludv/comando" na 1ª linha.
    br: titles.filter((t) => /bludv|comando|nerdfilmes|torrentdosfilmes/i.test(t)).length,
    cacheados: streams.filter((s) => String(s.name || '').includes('⚡')).length,
    viaDebrid: streams.filter((s) => s.url).length,
    p2p: streams.filter((s) => s.infoHash).length,
    // Campos internos nunca podem chegar ao Stremio.
    vazando: streams.some((s) => '_br' in s || '_seeders' in s || '_quality' in s),
  };
}

// Busca fria não cabe numa chamada só: os indexadores BR levam 6-8s e chegam
// depois que a resposta já saiu. O addon marca essa resposta com `max-age=0`
// pedindo pra perguntar de novo, e é isso que o cliente Stremio faz — então o
// smoke test faz o mesmo em vez de julgar a primeira lista que receber.
const MAX_TENTATIVAS = 5;

async function checkSearch() {
  console.log('\n── Busca ────────────────────────────────');
  console.log('  (busca fria: a resposta sai incompleta e o addon pede pra repetir;');
  console.log('   as fontes BR costumam entrar na 3ª chamada)\n');

  for (const entry of TITLES) {
    const [type, id, label] = entry.split('|');
    console.log(`  ${label || id}`);

    const tentativas = [];
    let last = null;
    try {
      for (let i = 0; i < MAX_TENTATIVAS; i += 1) {
        last = await get(`/stream/${type}/${id}.json`);
        const parcial = inspect(last.body?.streams || []);
        tentativas.push(last);
        console.log(
          `    ${i + 1}ª: ${parcial.total} stream(s), BR ${parcial.br}, ⚡ ${parcial.cacheados}` +
            ` em ${last.ms}ms${last.complete ? ' ✓ completa' : ' … incompleta, repetindo'}`,
        );
        if (last.complete) break;
      }
    } catch (err) {
      ok(label || id, false, err.message);
      continue;
    }

    const s = inspect(last.body?.streams || []);
    ok('  1ª resposta dentro do limite do Stremio', tentativas[0].ms < 10000, `${tentativas[0].ms}ms`);
    ok('  chegou a uma lista completa', last.complete, last.complete ? '' : `${MAX_TENTATIVAS} tentativas`);
    ok('  encontrou streams', s.total > 0);
    ok('  sem campos internos vazando', !s.vazando);
    if (s.total > 0 && !isDemo) {
      ok('  trouxe fonte BR', s.br > 0, s.br === 0 ? 'nenhuma — ver logs do addon' : `${s.br}`);
    }
    console.log('');
  }
}

async function checkUserConfig() {
  console.log('── Config por usuário ───────────────────');

  const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

  // Sem debrid: os streams têm que voltar como torrent P2P puro.
  const p2p = encode({ ds: '', dc: 0 });
  const a = await get(`/${p2p}/stream/movie/tt7286456.json`);
  const ai = inspect(a.body?.streams || []);
  ok('config "sem debrid" → P2P', ai.total === 0 || ai.p2p > 0, `${ai.p2p} P2P de ${ai.total}`);

  // maxResults deve ser respeitado.
  const small = encode({ m: 5 });
  const b = await get(`/${small}/stream/movie/tt7286456.json`);
  const bi = inspect(b.body?.streams || []);
  ok('config "máx. 5" respeitada', bi.total <= 5, `${bi.total} stream(s)`);

  // Filtro de qualidade.
  const only4k = encode({ q: '2160p' });
  const c = await get(`/${only4k}/stream/movie/tt7286456.json`);
  const titles = (c.body?.streams || []).map((s) => String(s.title));
  ok(
    'config "só 2160p" filtrou',
    titles.length === 0 || titles.every((t) => /2160p|4k|uhd/i.test(t)),
    `${titles.length} stream(s)`,
  );
}

(async () => {
  console.log(`\nSmoke test — ${BASE}`);
  try {
    await checkRoutes();
    await checkSearch();
    await checkUserConfig();
  } catch (err) {
    console.error('\nerro fatal:', err.message);
    console.error('o addon está rodando nessa URL?');
    process.exit(1);
  }

  console.log('─────────────────────────────────────────');
  console.log(failures === 0 ? 'tudo passou\n' : `${failures} verificação(ões) falharam\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
