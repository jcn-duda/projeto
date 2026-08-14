const test = require('node:test');
const assert = require('node:assert/strict');

// Replica das funções puras usadas nos resolvers para testes de regressão
function cleanPostTitle(title = '') {
  return String(title)
    .replace(/\s*Torrent\s*(?:[–-]|&#8211;)?\s*/gi, ' ')
    .replace(/\b(?:720p|1080p|2160p|4K)(?:\s*\/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*/gi, '')
    .replace(/\b\d{3,4}p\b/gi, '')
    .replace(/\b(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function releaseTitle(postTitle, link, index = null) {
  const clean = cleanPostTitle(typeof postTitle === 'string' ? postTitle : postTitle?.title || '');
  const epPart = link.episode != null ? `E${String(link.episode).padStart(2, '0')}` : '';
  const audioTag = link.audio === 'dublado' ? 'DUBLADO' : link.audio === 'legendado' ? 'LEGENDADO' : null;
  const tags = [
    link.quality ? `${link.quality}p` : null,
    link.source,
    audioTag,
    link.size || (index == null ? null : `opção ${index + 1}`),
  ].filter(Boolean);

  const base = epPart ? `${clean} ${epPart}` : clean;
  return tags.length ? `${base} [${tags.join(' ')}]` : base;
}

test('cleanPostTitle remove palavras de vitrine e resoluções do SEO', () => {
  const original = 'A Casa do Dragão 1ª Temporada Torrent (2022) WEB-DL 720p/1080p/4K Dual Áudio';
  const cleaned = cleanPostTitle(original);
  assert.equal(cleaned, 'A Casa do Dragão 1ª Temporada (2022) WEB-DL');
});

test('releaseTitle gera S01E01 com DUBLADO para episódio individual', () => {
  const post = 'A Casa do Dragão 1ª Temporada Torrent (2022) WEB-DL 720p/1080p/4K Dual Áudio';
  const link = { quality: 1080, audio: 'dublado', episode: 1, source: null, size: null };
  const title = releaseTitle(post, link, 0);
  assert.equal(title, 'A Casa do Dragão 1ª Temporada (2022) WEB-DL E01 [1080p DUBLADO opção 1]');
});

test('releaseTitle gera LEGENDADO para pack 4K sem vazar termo Dual Áudio', () => {
  const post = 'A Casa do Dragão 1ª Temporada Torrent (2022) WEB-DL 720p/1080p/4K Dual Áudio';
  const link = { quality: 2160, audio: 'legendado', episode: null, source: null, size: null };
  const title = releaseTitle(post, link, 22);
  assert.equal(title, 'A Casa do Dragão 1ª Temporada (2022) WEB-DL [2160p LEGENDADO opção 23]');
  assert.equal(title.includes('Dual'), false);
  assert.equal(title.includes('DUBLADO'), false);
});
