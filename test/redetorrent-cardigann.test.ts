import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Ajustes do card Redetorrent: details do cardigann lendo o post.url de
// elemento próprio, date "now", priorização de Série com temporada na query
// e candidatos automáticos de failover. O grosso da suíte do perfil mora em
// redetorrent-resolver.test.ts; este arquivo carrega os mesmos dublês.
import redetorrentShim from '../redetorrent-resolver/server.js';
import redetorrentParsers from '../resolvers/profiles/redetorrent-parsers.js';
const redetorrent: any = redetorrentShim;
const parsers: any = redetorrentParsers;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = (name: any) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'redetorrent', name), 'utf8');

const postHtml = fixture('post-coringa-delirio.html');

const SITE = 'https://www.redetorrent.xyz';
const POST_URL = `${SITE}/filmes/coringa-delirio-a-dois/`;

describe('redetorrent: página sintética expõe post.url para o details do cardigann', () => {
  const links: any[] = parsers.parsePostLinks(postHtml, { url: POST_URL });
  const post = { url: POST_URL, title: 'Coringa: Delírio a Dois (2024)', year: 2024 };
  const searchPageHtml = parsers.createRedeSearchPageHtml();

  test('post.url tem elemento próprio (div.post > a) com o href intacto', () => {
    const items = links.map((link, index) => ({ post, link, index, count: links.length }));
    const html = searchPageHtml(items);
    assert.ok(
      html.includes(`<div class="post"><a href="${POST_URL}">`),
      'o HTML sintético precisa ter div.post > a apontando para o post.url',
    );
    // O href do TÍTULO continua o magnet (download direto, sem /resolve).
    const prefix = links[0].url.slice(0, 40).replace(/&/g, '&amp;');
    assert.ok(html.includes(`href="${prefix}`));
    assert.ok(!html.includes('/resolve'));
  });

  test('cardigann: details lê o HREF do post e date usa now', () => {
    const yml = fs.readFileSync(
      path.join(__dirname, '..', 'jackett-bludv', 'redetorrent-cardigann.yml'),
      'utf8',
    );
    // Blocos de campo: cortam na próxima chave a 4 espaços (comentários a 6
    // espaços ficam DENTRO do bloco do próprio campo).
    const field = (name: string) =>
      yml.split(/\n    (?=[a-zA-Z])/).find((chunk) => chunk.startsWith(`${name}:`)) || '';
    const detailsBlock = field('details');
    assert.match(detailsBlock, /selector:\s*"div\.post > a"/);
    assert.match(detailsBlock, /attribute:\s*href/);
    // O details NÃO pode voltar a colar texto (description) — virava URL quebrada.
    assert.doesNotMatch(detailsBlock, /selector:\s*"div\.description"/);
    assert.match(field('date'), /text:\s*now/);
  });
});

describe('redetorrent: temporada na query prioriza Série antes do corte', () => {
  // Ordem REAL de risco: TRÊS filmes com o token "Fallout" na frente da série
  // — com MAX_POSTS=3, o código antigo (sem priorização) expulsava a série do
  // corte. hrefs RELATIVOS: o baseUrl real do seletor tem que sobreviver.
  const falloutHtml = `
    <html><body><div class="listagem">
    <div class="item"><a href="/filmes/cesium-fallout/" title="Cesium Fallout (2021)"><h2 class="item-titulo">Cesium Fallout (2021)</h2></a></div>
    <div class="item"><a href="/filmes/missao-impossivel-efeito-fallout/" title="Missão: Impossível – Efeito Fallout (2018)"><h2 class="item-titulo">Missão: Impossível – Efeito Fallout (2018)</h2></a></div>
    <div class="item"><a href="/filmes/fallout-4-pc/" title="Fallout 4 (PC) (2024)"><h2 class="item-titulo">Fallout 4 (PC) (2024)</h2></a></div>
    <div class="item"><a href="/series/fallout/" title="Fallout 1ª 2ª Temporada (2025)"><h2 class="item-titulo">Fallout 1ª 2ª Temporada (2025)</h2></a></div>
    </div></body></html>`;

  test('Fallout S02: a série entra em 1º no corte de 3 e UM filme fica fora', () => {
    // Mesma forma da chamada do perfil: query JÁ normalizada (Sxx sai) e a
    // temporada como match da query ORIGINAL.
    const s02 = 'Fallout S02'.match(/\b[Ss](\d{1,2})(?:[Ee]\d{1,2})?\b/);
    const posts = redetorrent.selectSearchPosts(falloutHtml, 'Fallout', s02);
    assert.equal(posts.length, 3, 'MAX_POSTS=3: a série desloca um filme para fora');
    assert.equal(posts[0].type, 'Série', 'a série precisa vir antes do corte MAX_POSTS');
    assert.equal(posts[0].url, `${SITE}/series/fallout/`, 'href relativo resolvido com o baseUrl real');
    // Os demais são filmes relevantes (matching não relaxou: nada excluído a
    // priori — um só saiu pelo corte depois da reordenação).
    assert.ok(posts.slice(1).every((p: any) => p.type === 'Filme'));
    const urls = posts.map((p: any) => p.url);
    assert.equal(urls.filter((u: string) => u.includes('/filmes/')).length, 2);
  });

  test('sem temporada na query, a ordem do site é preservada e a série fica FORA do corte', () => {
    const posts = redetorrent.selectSearchPosts(falloutHtml, 'Fallout', null);
    assert.equal(posts.length, 3);
    assert.ok(posts[0].url.includes('/filmes/cesium-fallout/'));
    assert.ok(!posts.some((p: any) => p.type === 'Série'), 'sem priorização, a série é cortada (comportamento antigo)');
  });
});

describe('redetorrent: failover de domínio', () => {
  test('www.redetorrent.xyz e redetorrent.com entram como candidatos E na allowlist', () => {
    // Contrato nominal: redetorrent.com é mirror da lista embutida, não só
    // default do csv.
    assert.ok(parsers.FALLBACK_SITE_SUFFIXES.includes('redetorrent.com'));
    assert.ok(parsers.FALLBACK_SITE_SUFFIXES.includes('redetorrent.xyz'));
    const hosts: string[] = redetorrent.siteSelector.hosts();
    assert.ok(hosts.includes('www.redetorrent.xyz'), `hosts: ${hosts.join(', ')}`);
    assert.ok(hosts.includes('redetorrent.com'), `hosts: ${hosts.join(', ')}`);
    assert.equal(redetorrent.isDetailHost('redetorrent.com'), true);
    assert.doesNotThrow(() =>
      redetorrent.assertAllowedUrl('https://redetorrent.com/series/fallout/'),
    );
  });

  test('REDETORRENT_URLS definido substitui o default (override por env vale)', () => {
    const selector = redetorrent.createSiteSelector(
      '[teste]', 'https://mirror-a.example,https://mirror-b.example',
      'https://www.redetorrent.xyz', parsers.FALLBACK_SITE_SUFFIXES,
    );
    const hosts: string[] = selector.hosts();
    assert.ok(hosts.includes('mirror-a.example'));
    assert.ok(hosts.includes('mirror-b.example'));
    // redetorrent.com segue presente (agora é mirror embutido da lista de
    // sufixos) — o que o teste prova é que o csv da env É acrescido.
    assert.ok(hosts.includes('redetorrent.com'));
    assert.ok(hosts.includes('redetorrent.xyz'));
  });
});
