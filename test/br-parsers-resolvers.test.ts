import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

import comando from '../comandotorrents-resolver/server.js';
import tdf from '../torrentdosfilmes-resolver/server.js';
import nerd from '../nerdfilmes-resolver/server.js';

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

// --- NerdFilmes --------------------------------------------------------

test('nerdfilmes: card sem title não vira release e a URL repetida entra uma vez', () => {
  const posts = nerd.parsePosts(fixture('nerdfilmes-search.html'));

  assert.deepEqual(posts, [
    {
      url: 'https://nerdfilmes.org/senhor-dos-aneis-a-sociedade-do-anel/',
      title: 'O Senhor dos Anéis: A Sociedade do Anel Torrent (2001) BluRay 1080p Dual Áudio',
    },
    { url: 'https://nerdfilmes.org/matrix/', title: 'Matrix Torrent (1999) BluRay 2160p Dublado' },
  ]);
});

test('nerdfilmes: só âncora com host protetor vira botão', () => {
  const links = nerd.parseDownloadLinks(fixture('nerdfilmes-post.html'));

  // O botão do Telegram tem a mesma classe dos de download: quem filtra é o host.
  assert.deepEqual(
    links.map((link) => link.url),
    [
      'https://systemads1.com/go/nf-aaa',
      'https://videosad.net/go/nf-bbb',
      'https://systemads.net/go/nf-ccc',
    ],
  );
  assert.deepEqual(
    links.map((link) => ({ q: link.quality, size: link.size, audio: link.audio })),
    [
      { q: 1080, size: '3.2 GB', audio: 'dublado' },
      { q: 2160, size: '28.7 GB', audio: 'dublado' },
      { q: 720, size: '1.4 GB', audio: 'legendado' },
    ],
  );
});

test('nerdfilmes: parsePostDate lê o meta de publicação em ISO', () => {
  // A data alimenta o pubDate do feed; sem ela o Jackett ordena tudo por "agora".
  assert.equal(nerd.parsePostDate(fixture('nerdfilmes-post.html')), '2024-05-09T16:45:00.000Z');
  assert.equal(nerd.parsePostDate('<html><body>sem meta</body></html>'), null);
});


// --- NerdFilmes: layout novo (magnet direto no href) --------------------
//
// O tema trocou o botão protegido pelo magnet direto
// ("magnet:?xt=urn:btih:..."), como o BLUDV já fazia. Qualidade/áudio/tamanho
// continuam saindo do texto ao redor — <h3> da seção ("S05.1080p | MKV |
// 2.19 GB | Dual Áudio:") e texto da âncora ("1080p") —; o que mudou é o href,
// que deixa de passar por fetch. Contrato do magnet: só entra com
// xt=urn:btih de 40 hex ou 32 base32 em QUALQUER posição da query; sem btih
// (nem só btmh), curto ou com caractere fora do alfabeto, o link é ignorado.
// Antes do patch o href magnet tinha hostname vazio, caía fora do allowlist e
// o post inteiro voltava sem nenhum botão.

test('nerdfilmes: magnet direto vira botão no layout de série (E01/E02, qualidade no texto da âncora)', () => {
  // Estrutura real do site: <h3> com spec por seção + "Episódio NN:" antes de
  // cada magnet; o texto da âncora é só a qualidade ("1080p"). O &amp; do href
  // tem que virar & — magnet com entidade não resolve.
  const html = `
    <h3 style="text-align: center;"><strong>S05.1080p | MKV | 2.19 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><span style="color: #808080;">Episódio 01:</span> <a href="magnet:?xt=urn:btih:14ab38e43956dc45f05f9c1770fe5b6330c6ef71&amp;dn=Harley.Quinn.S05E01.1080p.DUAL" rel="noopener">1080p</a></strong></p>
    <p style="text-align: center;"><strong><span style="color: #808080;">Episódio 02:</span> <a href="magnet:?xt=urn:btih:2d0f6c3c2d281142f6d82ebdca6891a1c4b6c2d2&amp;dn=Harley.Quinn.S05E02.1080p.DUAL" rel="noopener">1080p</a></strong></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 2, 'os dois magnet diretos viram botão');
  assert.equal(
    links[0].url,
    'magnet:?xt=urn:btih:14ab38e43956dc45f05f9c1770fe5b6330c6ef71&dn=Harley.Quinn.S05E01.1080p.DUAL',
  );
  assert.equal(
    links[1].url,
    'magnet:?xt=urn:btih:2d0f6c3c2d281142f6d82ebdca6891a1c4b6c2d2&dn=Harley.Quinn.S05E02.1080p.DUAL',
  );
  // E01 herda o spec do <h3> (tamanho incluso); E02 só tem o "1080p" do próprio
  // texto — tamanho ausente vira o sentinela "1 KB" no feed, não inventado.
  assert.deepEqual(
    links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio })),
    [
      { episode: 1, quality: 1080, size: '2.19 GB', audio: 'dublado' },
      { episode: 2, quality: 1080, size: null, audio: 'dublado' },
    ],
  );
});

test('nerdfilmes: magnet direto vira botão no layout de filme (spec no <h3>, âncora só com imagem)', () => {
  // Post de filme real: <h3> "BluRay 1080p | MKV | 2.6 GB | Dual Áudio:" e a
  // âncora sem texto nenhum (só <img>) — a qualidade não pode depender do
  // texto da âncora aqui. O href usa &#038; em vez de &amp;.
  const html = `
    <h3 style="text-align: center;"><strong>BluRay 1080p | MKV | 2.6 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><a rel="nofollow" href="magnet:?xt=urn:btih:acb6b94265ac592f8871c34e16e6e00a3aa6daa8&#038;dn=Coringa.2019.1080p.DUAL"><img src="/magnet-link-download.png" alt="Magnet Link"></a></strong></p>
    <h3 style="text-align: center;"><strong>BluRay 2160p | MKV | 13 GB | Dual Áudio:</strong></h3>
    <p style="text-align: center;"><strong><a rel="nofollow" href="magnet:?xt=urn:btih:c129c07cb646e9b0f7618489bfb3fce24ce67912&#038;dn=Coringa.2019.2160p.DUAL"><img src="/magnet-link-download.png" alt="Magnet Link"></a></strong></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'magnet:?xt=urn:btih:acb6b94265ac592f8871c34e16e6e00a3aa6daa8&dn=Coringa.2019.1080p.DUAL');
  assert.equal(links[1].url, 'magnet:?xt=urn:btih:c129c07cb646e9b0f7618489bfb3fce24ce67912&dn=Coringa.2019.2160p.DUAL');
  assert.deepEqual(
    links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio, source: link.source })),
    [
      { episode: null, quality: 1080, size: '2.6 GB', audio: 'dublado', source: 'BluRay' },
      { episode: null, quality: 2160, size: '13 GB', audio: 'dublado', source: 'BluRay' },
    ],
  );
});

test('nerdfilmes: qualidade e "Dual Áudio" no texto da âncora guiam o botão (E01/E02)', () => {
  // Layout descrito no pedido: o botão carrega qualidade E trilha no próprio
  // texto ("720p Dual Áudio"). A qualidade tem que sair da âncora (o segmento
  // não tem resolução) e o áudio da seção continua valendo.
  const html = `
    <h3>VERSÃO MKV DUAL ÁUDIO</h3>
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=ep01.720p">720p Dual Áudio</a></p>
    <p><a href="magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=ep01.1080p">1080p Dual Áudio</a></p>
    <p>EPISÓDIO 02</p>
    <p><a href="magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=ep02.2160p">2160p Dual Áudio</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map((link) => ({ episode: link.episode, quality: link.quality, size: link.size, audio: link.audio })),
    [
      { episode: 1, quality: 720, size: null, audio: 'dublado' },
      { episode: 1, quality: 1080, size: null, audio: 'dublado' },
      { episode: 2, quality: 2160, size: null, audio: 'dublado' },
    ],
  );
});

test('nerdfilmes: "Dual Áudio"/"Legendado" só no texto da âncora também define a trilha', () => {
  // Sem <h3> de seção antes dos botões, o rótulo da trilha mora na âncora.
  // Se o parser ler áudio só do segmento, estes botões saem "desconhecido" e a
  // vaga BR reservada do addon (dublado) fica em risco — o contrato do layout
  // novo é o texto da âncora mandar. Ajuste aqui se o site real nunca publicar
  // trilha na âncora: este teste é o espelho do pedido, não da fixture.
  const html = `
    <p>EPISÓDIO 01</p>
    <p><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ep01.1080p">1080p Dual Áudio</a></p>
    <p><a href="magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=ep01.720p">720p Legendado</a></p>
  `;
  const links = nerd.parseDownloadLinks(html);

  assert.deepEqual(
    links.map((link) => ({ quality: link.quality, audio: link.audio })),
    [
      { quality: 1080, audio: 'dublado' },
      { quality: 720, audio: 'legendado' },
    ],
  );
});

