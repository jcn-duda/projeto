const assert = require('node:assert/strict');
const {
  parsePosts,
  parseDownloadLinks,
  parsePostDate,
  parseSize,
  releaseTitle,
  pubDate,
  assertAllowedUrl,
  isDetailHost,
  siteSelector,
} = require('./server');

const searchHtml = `
  <article class="featured col item">
    <div class="item"><div class="image">
      <a title="Alice in Borderland 3ª Temporada (2025)" href="https://www.xnerdfilmes.net/alice-3/">
        <img src="poster.jpg">
      </a>
    </div></div>
  </article>
  <article class="col"><div class="image">
    <a href="https://www.xnerdfilmes.net/coringa-2019/" title="Coringa (2019)"></a>
  </div></article>`;

const postHtml = `
  <meta property="article:published_time" content="2025-09-25T12:00:00-03:00">
  <h3>BluRay 1080p | MKV | 2,6 GB | Dual Áudio</h3>
  <a rel="nofollow" href="https://systemads1.com/go.php?id=abc"><img alt="Magnet"></a>
  <h3>WEB-DL 4K x265 | 13 GB | Legendado</h3>
  <a href="https://videosad.net/links.php?id=xyz" rel="nofollow">Magnet</a>`;

const posts = parsePosts(searchHtml);
assert.equal(posts.length, 2);
assert.equal(posts[0].title, 'Alice in Borderland 3ª Temporada (2025)');
assert.equal(posts[1].url, 'https://www.xnerdfilmes.net/coringa-2019/');

const links = parseDownloadLinks(postHtml);
assert.equal(links.length, 2);
assert.deepEqual(
  { quality: links[0].quality, size: links[0].size, audio: links[0].audio, source: links[0].source },
  { quality: 1080, size: '2,6 GB', audio: 'dublado', source: 'BluRay' },
);
assert.equal(links[1].quality, 2160);
assert.equal(links[1].audio, 'legendado');
assert.equal(parseSize('2,6 GB'), Math.round(2.6 * 1024 ** 3));
assert.equal(parsePostDate(postHtml), '2025-09-25T15:00:00.000Z');
assert.match(releaseTitle('Coringa (2019)', links[0]), /1080p BluRay DUBLADO/);
assert.equal(pubDate({ title: 'Coringa (2019)' }), 'Tue, 01 Jan 2019 00:00:00 GMT');
assert.equal(siteSelector.url(), 'https://www.filmesviatorrents.net');
assert.equal(isDetailHost('filmesviatorrents.net'), true);
assert.equal(isDetailHost('www.filmesviatorrents.net'), true);
assert.equal(isDetailHost('fakefilmesviatorrents.net'), false);
assert.doesNotThrow(() => assertAllowedUrl('https://www.filmesviatorrents.net/?s=teste'));
assert.throws(() => assertAllowedUrl('https://fakefilmesviatorrents.net/?s=teste'), /blocked_host/);

console.log('nerdfilmes-resolver: testes OK');
