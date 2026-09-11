import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parsers HTML dos quatro resolvedores BR, contra fixture congelada.
 *
 * Substitui o test/resolvers.test.js antigo, que reimplementava as funções no
 * próprio teste: a cópia passava mesmo quando o original quebrava. Aqui o
 * módulo real é carregado — o que só é possível porque os quatro passaram a
 * exportar `createServer` e só abrem porta quando são o processo principal.
 *
 * O que isto NÃO cobre está escrito em test/fixtures/README.md: fixture
 * congelada não avisa quando o site muda de layout. Ela trava o parser contra
 * refatoração, que é o outro modo de falha.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

import bludv from '../bludv-resolver/server.js';
import comando from '../comandotorrents-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';

// --- BLUDV -------------------------------------------------------------

test('bludv: seção de áudio vale para os botões seguintes, até a próxima seção', () => {
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));

  // O marcador está no <h3>, não em cada botão: quem herda errado publica o
  // pack legendado como dublado e ele ganha a vaga BR reservada.
  assert.deepEqual(
    links.map((link) => link.audio),
    ['dublado', 'dublado', 'dublado', 'dublado', 'legendado', 'legendado'],
  );
});

test('bludv: "TEMPORADA COMPLETA" zera o episódio corrente', () => {
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));

  // Sem o reset, o pack depois do EPISÓDIO 02 herdava E02 e virava um episódio
  // de 18 GB na lista.
  assert.deepEqual(
    links.map((link) => link.episode),
    [null, null, 1, 2, null, null],
  );
});

test('bludv: qualidade e tamanho atravessam codec/HDR entre a resolução e o parêntese', () => {
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));

  // "WEB-DL 2160p x265 DV (24 GB)" — o "x265 DV" no meio não pode cortar o par.
  assert.deepEqual({ quality: links[1].quality, size: links[1].size }, { quality: 2160, size: '24 GB' });
  // "4K" sem número também vale 2160.
  assert.equal(links[4].quality, 2160);
  // A lista "720p/1080p/4K" do título do post não tem parêntese e não vira spec.
  assert.deepEqual({ quality: links[0].quality, size: links[0].size }, { quality: 1080, size: '2.67 GB' });
  // Botão sem nada anunciado: null, e não a herança do botão anterior.
  assert.deepEqual({ quality: links[5].quality, size: links[5].size }, { quality: null, size: null });
  // O lixo colado no tamanho ("3.39 GB &#8211; MKV") já sai cortado do parser;
  // o feed não precisa mais limpar entidade.
  assert.equal(links[2].size, '3.39 GB');
});

test('bludv: card de busca sem poster/título original devolve null, sem herdar do anterior', () => {
  const posts = bludv.parsePosts(fixture('bludv-search.html'));

  assert.equal(posts.length, 3);
  assert.deepEqual(posts[0], {
    url: 'https://bludvfilmes.xyz/a-casa-do-dragao-1a-temporada/',
    title: 'A Casa do Dragão 1ª Temporada Torrent – (2022) WEB-DL 720p/1080p/4K Dual Áudio',
    date: '14/08/2022',
    poster: 'https://bludvfilmes.xyz/wp-content/uploads/2022/08/casa-do-dragao.jpg',
    original: 'House of the Dragon',
  });
  assert.deepEqual(
    { poster: posts[2].poster, original: posts[2].original, date: posts[2].date },
    { poster: null, original: null, date: null },
  );
  // As entidades saem decodificadas do próprio parser (decodeEntities genérico):
  // &amp; vira & e &#8211; vira –, nada chega cru ao feed.
  assert.equal(posts[2].title, 'Tom & Jerry Torrent – (2021) WEBRip');
});

test('bludv: pickBestLink prefere dublado e, dentro dele, a maior qualidade', () => {
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));

  assert.equal(bludv.pickBestLink(links).url, 'https://systemads1.com/go/bbb222');
  // Preferência explícita inverte o ranking de áudio.
  assert.equal(bludv.pickBestLink(links, { audio: 'legendado' }).url, 'https://systemads.net/go/eee555');
});

test('bludv: o feed usa o tamanho limpo do parser e o sentinela quando não há', () => {
  const posts = bludv.parsePosts(fixture('bludv-search.html'));
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));
  const html = bludv.searchPageHtml(links.map((link, index) => ({ post: posts[0], link, index })));

  const sizes = [...html.matchAll(/<div class="size">([^<]*)<\/div>/g)].map((m) => m[1]);
  // O corte do lixo ("3.39 GB &#8211; MKV" → "3.39 GB") agora acontece no
  // parser; sem tamanho vai 1 KB (o Jackett descarta release sem tamanho, e o
  // addon lê <= 1 KB como "não sei").
  assert.deepEqual(sizes, ['2.67 GB', '24 GB', '3.39 GB', '1.20 GB', '18.4 GB', '1 KB']);
});

test('bludv: releaseTitle tira a vitrine do título e assume os atributos do botão', () => {
  const links = bludv.parseDownloadLinks(fixture('bludv-post.html'));
  const postTitle = bludv.parsePosts(fixture('bludv-search.html'))[0].title;

  // A fonte entra na tag junto com qualidade e áudio, igual ao comandotorrents.
  assert.equal(
    bludv.releaseTitle(postTitle, links[2]),
    'A Casa do Dragão 1ª Temporada (2022) E01 [720p WEB-DL DUBLADO]',
  );
  // O 4K legendado não pode sair com "Dual Áudio" herdado do título do post.
  const pack = bludv.releaseTitle(postTitle, links[4]);
  assert.equal(pack, 'A Casa do Dragão 1ª Temporada (2022) [2160p WEB-DL LEGENDADO]');
  assert.equal(pack.includes('Dual'), false);
});

test('bludv: normalizeQuery tira SxxEyy com fronteira de palavra', () => {
  // O strip serve pro buscador WordPress achar o post da temporada.
  assert.equal(bludv.normalizeQuery('A Casa do Dragão S01E02'), 'A Casa do Dragão');
  assert.equal(bludv.normalizeQuery('A Casa do Dragão S01'), 'A Casa do Dragão');
  // Sem \b o strip antigo comia pedaço de título: "S1m0ne" virava " m0ne" e a
  // busca zerava. Título com S+dígito dentro de palavra sobrevive inteiro.
  assert.equal(bludv.normalizeQuery('S1m0ne 2002'), 'S1m0ne 2002');
  // ":" engasga o buscador WordPress (mesma regra do scraper nativo do addon).
  assert.equal(bludv.normalizeQuery('O Poderoso Chefão: Parte II'), 'O Poderoso Chefão Parte II');
});

test('bludv: âncora com atributos antes do href continua virando botão', () => {
  // Tema WordPress pode emitir <a class="..." target="..." href="...">; exigir
  // href como primeiro atributo apagaria todos os botões nessa troca de layout.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>TEMPORADA COMPLETA – BluRay 1080p (2.67 GB)</p>
    <p><a class="btn magnet" target="_blank" href="https://systemads1.com/go/x1">Magnet-Link</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.deepEqual(
    { url: links[0].url, quality: links[0].quality, size: links[0].size, audio: links[0].audio },
    { url: 'https://systemads1.com/go/x1', quality: 1080, size: '2.67 GB', audio: 'dublado' },
  );
});

test('bludv: card de busca com atributos antes do href continua parseado', () => {
  const html = `<div class="posts">
    <div class="post">
      <div class="title">
        <a rel="bookmark" href="https://bludvfilmes.xyz/duna/">Duna Torrent (2021) BluRay</a>
      </div>
      <div class="content"><p>x</p></div>
    </div>
  </div>`;
  const posts = bludv.parsePosts(html);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://bludvfilmes.xyz/duna/');
  assert.equal(posts[0].title, 'Duna Torrent (2021) BluRay');
});

test('bludv: janela maior casa qualidade e tamanho com codec/HDR/áudio longos', () => {
  // O texto entre a resolução e o parêntese passa de 30 chars em releases com
  // HDR e trilhas de áudio ("x265 DV HDR10+ DDP 5.1 Atmos TrueHD"); janela
  // curta soltava o par e o tamanho saía sentinela "1 KB".
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>TEMPORADA COMPLETA – WEB-DL 2160p x265 DV HDR10+ DDP 5.1 Atmos TrueHD (24 GB)</p>
    <p><a href="https://systemads1.com/go/long">Magnet-Link</a></p>
  `;
  const [link] = bludv.parseDownloadLinks(html);

  assert.deepEqual({ quality: link.quality, size: link.size }, { quality: 2160, size: '24 GB' });
});

test('bludv: magnet direto no href vira botão com qualidade pelo texto da âncora', () => {
  // Layout atual: o botão aponta direto pro magnet (sem protetor) e a qualidade
  // vem do texto da âncora ("720p Dublado") — não existe mais a linha
  // "WEB-DL 1080p (2.67 GB)" antes do botão pra alimentar o spec antigo, e o
  // tamanho não é publicado. Esquecer o texto da âncora deixaria 3 botões com
  // quality null: a vaga BR reservada (dublado) até sobreviveria, mas a
  // ordenação por qualidade dentro do dublado viraria loteria.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.720p">720p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=ep01.2160p">2160p Dublado</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map((link) => ({
      url: link.url,
      audio: link.audio,
      episode: link.episode,
      quality: link.quality,
      size: link.size,
    })),
    [
      { url: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.720p', audio: 'dublado', episode: 1, quality: 720, size: null },
      { url: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep01.1080p', audio: 'dublado', episode: 1, quality: 1080, size: null },
      { url: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=ep01.2160p', audio: 'dublado', episode: 1, quality: 2160, size: null },
    ],
  );
});

test('bludv: magnet direto com href em aspas simples também vira botão', () => {
  // O tema WordPress alterna as aspas do atributo; exigir aspas duplas apagaria
  // o botão inteiro nessa variação de layout. "4K" no texto da âncora vale 2160,
  // mesma regra do spec por segmento.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href='magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=ep01.4k'>4K Dublado</a></p>
  `;
  const [link] = bludv.parseDownloadLinks(html);

  assert.equal(link.url, 'magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=ep01.4k');
  assert.deepEqual(
    { audio: link.audio, episode: link.episode, quality: link.quality, size: link.size },
    { audio: 'dublado', episode: 1, quality: 2160, size: null },
  );
});

test('bludv: href HTTP para host fora da allowlist é ignorado; protetor continua aceito', () => {
  // Botão externo (afiliado/Telegram) no meio do post não pode virar release
  // BR — o filtro é por host, igual no layout com protetor. E o protetor
  // permitido no mesmo post continua entrando, sem herdar o lixo descartado.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="https://exemplo-invalido.com.br/go/xyz">1080p Dublado</a></p>
    <p><a href="https://t.me/bludv">Telegram</a></p>
    <p><a href="https://systemads1.com/go/aaa111">1080p Dublado</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.deepEqual(
    { url: links[0].url, quality: links[0].quality, audio: links[0].audio, episode: links[0].episode },
    { url: 'https://systemads1.com/go/aaa111', quality: 1080, audio: 'dublado', episode: 1 },
  );
});

test('bludv: magnet malformado é ignorado; só btih válido vira botão', () => {
  // O magnet direto aceito no layout novo precisa ter xt=urn:btih com hash hex
  // de 40 chars: sem o xt o cliente de torrent não sabe o que baixar, e hash
  // curto ou fora do alfabeto hex nunca resolve — link que iria pro play e
  // quebraria, ou release fantasma gastando a vaga BR reservada.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:abc123&dn=ep01.1080p">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz&dn=ep01.1080p">1080p Dublado</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.1080p');
  assert.deepEqual(
    { audio: links[0].audio, episode: links[0].episode, quality: links[0].quality, size: links[0].size },
    { audio: 'dublado', episode: 1, quality: 1080, size: null },
  );
});

// --- ComandoTorrents ---------------------------------------------------

test('comandotorrents: href relativo vira absoluto e o card repetido é deduplicado', () => {
  const posts = comando.parsePosts(fixture('comandotorrents-search.html'));

  assert.equal(posts.length, 2, 'o card duplicado e o article sem âncora não entram');
  assert.equal(posts[1].url, 'https://comandotorrents.to/oppenheimer/');
  assert.equal(posts[0].poster, '/wp-content/uploads/2024/06/furiosa.jpg');
});

test('comandotorrents: botão com href relativo resolve contra a URL do post', () => {
  const base = 'https://comandotorrents.to/furiosa-uma-saga-mad-max/';
  const links = comando.parseDownloadLinks(fixture('comandotorrents-post.html'), base);

  assert.equal(links.length, 3, 'link interno do post não é botão de download');
  assert.equal(
    links[1].url,
    'https://comandotorrents.to/redirect?to=https%3A%2F%2Fvideosad.net%2Fgo%2Fct-bbb',
  );
  assert.deepEqual(
    links.map((link) => ({ q: link.quality, size: link.size, audio: link.audio, source: link.source })),
    [
      { q: 1080, size: '2.4 GB', audio: 'dublado', source: 'WEB-DL' },
      { q: 2160, size: '45.1 GB', audio: 'dublado', source: 'REMUX' },
      { q: 720, size: '950 MB', audio: 'legendado', source: 'WEBRIP' },
    ],
  );
});

test('comandotorrents: releaseTitle numera a opção quando o botão não anuncia tamanho', () => {
  const post = 'A Casa do Dragão 1ª Temporada Torrent (2022) WEB-DL 720p/1080p/4K Dual Áudio';
  const link = { quality: 1080, audio: 'dublado', episode: 1, source: null, size: null };

  assert.equal(
    comando.releaseTitle(post, link, 0 as any),
    'A Casa do Dragão 1ª Temporada (2022) E01 [1080p DUBLADO opção 1]',
  );
  // Sem índice e sem atributos, sobra só o título limpo — as resoluções da
  // vitrine ("720p/1080p/4K"), codecs e palavras de SEO saem.
  assert.equal(
    comando.releaseTitle(post, { quality: null, audio: 'desconhecido', episode: null, source: null, size: null }),
    'A Casa do Dragão 1ª Temporada (2022)',
  );

  // Pack 4K legendado: "Dual Áudio" do título do post não pode sobreviver e
  // muito menos virar DUBLADO — é a vaga BR reservada que está em jogo.
  const pack = comando.releaseTitle(
    post,
    { quality: 2160, audio: 'legendado', episode: null, source: null, size: null },
    22 as any,
  );
  assert.equal(pack, 'A Casa do Dragão 1ª Temporada (2022) [2160p LEGENDADO opção 23]');
  assert.equal(/Dual|DUBLADO/.test(pack), false);
});

// --- TorrentDosFilmes --------------------------------------------------

test('torrentdosfilmes: magnet no href é preservado como está', () => {
  const links = tdf.parseDownloadLinks(fixture('torrentdosfilmes-post.html'));

  assert.equal(links.length, 3, 'link para a home não é botão de download');
  // O &amp; do HTML tem que virar & — magnet com entidade não resolve.
  assert.equal(
    links[0].url,
    'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Interestelar.2014.1080p',
  );
  assert.deepEqual(
    links.map((link) => link.audio),
    ['dublado', 'dublado', 'legendado'],
  );
});

test('torrentdosfilmes: âncora sem href é ignorada e URL repetida entra uma vez', () => {
  const posts = tdf.parsePosts(fixture('torrentdosfilmes-search.html'));

  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, 'Interestelar Torrent (2014) BluRay 1080p Dual Áudio');
  // Relativo resolvido contra o SITE_URL do módulo — o host é configurável,
  // o caminho não.
  assert.equal(new URL(posts[1].url).pathname, '/duna-torrent/');
});

test('torrentdosfilmes: parseSize converte as unidades que o site publica', () => {
  assert.equal(tdf.parseSize('2.9 GB'), Math.round(2.9 * 1024 ** 3));
  // Vírgula decimal é o formato do site em português.
  assert.equal(tdf.parseSize('1,5 GB'), Math.round(1.5 * 1024 ** 3));
  assert.equal(tdf.parseSize('950 MB'), 950 * 1024 ** 2);
  assert.equal(tdf.parseSize('sem tamanho'), null);
});
