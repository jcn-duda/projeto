const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Parser do bludv-resolver após a paridade com o comandotorrents: metadados
 * no texto da âncora (layout de magnet direto), qualidade/fonte normalizadas,
 * cleanPostTitle e parsePosts com dedup/href relativo.
 *
 * A fixture congelada (test/br-parsers.test.js) continua sendo a trava dos
 * posts antigos; aqui ficam os comportamentos NOVOS que ela não cobre.
 */
const bludv = require('../bludv-resolver/server');

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';
const H4 = '4444444444444444444444444444444444444444';

const magnet = (hash, dn = 'x') => `magnet:?xt=urn:btih:${hash}&dn=${dn}`;

// --- Âncora decide, mas não persiste -----------------------------------

test('bludv: áudio e episódio no texto da âncora valem só para o próprio botão', () => {
  // Layout de magnet direto: "Episódio 01 1080p Dublado" mora DENTRO do botão.
  // Se o valor fosse pro estado, o segundo botão (âncora sem nada) sairia
  // dublado/E01 — o matchesEpisode do addon casaria o episódio errado.
  const html = `
    <h3>VERSÃO MP4 LEGENDADO</h3>
    <p><a href="${magnet(H1, 'e1')}">Episódio 01 1080p Dublado</a></p>
    <p><a href="${magnet(H2, 'e2')}">720p</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 2);
  assert.deepEqual(links.map((l) => l.episode), [1, null], 'o E01 da âncora não vaza');
  assert.deepEqual(links.map((l) => l.audio), ['dublado', 'legendado'], 'a seção continua mandando');
  assert.deepEqual(links.map((l) => l.quality), [1080, 720], 'qualidade da âncora é local');
});

test('bludv: marcador de pack na âncora zera o episódio só do próprio botão', () => {
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 02</p>
    <p><a href="${magnet(H1)}">1080p</a></p>
    <p><a href="${magnet(H2)}">TEMPORADA COMPLETA 1080p</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.episode), [2, null]);
});

test('bludv: faixa "Episódios 01 ao 10" é pack, não episódio 10', () => {
  // Sem a regra de faixa, extractEpisode devolveria 10 e o pack de temporada
  // inteira viraria "E10" na lista — um episódio de 18 GB.
  const html = `
    <h3>DUAL ÁUDIO</h3>
    <p>EPISÓDIO 05</p>
    <p><a href="${magnet(H1)}">1080p</a></p>
    <p><a href="${magnet(H2)}">Episódios 01 ao 10 720p</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.episode), [5, null]);
});

test('bludv: S01E02, 1x02 e Capítulo NN na âncora', () => {
  const html = `
    <p><a href="${magnet(H1)}">S01E02 1080p</a></p>
    <p><a href="${magnet(H2)}">1x03 720p</a></p>
    <p><a href="${magnet(H3)}">Capítulo 04</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.episode), [2, 3, 4]);
});

test('bludv: episódio e pack no MESMO segmento desempateiam pela posição', () => {
  // Quem vem por último no segmento manda: "EPISÓDIO 05 – TEMPORADA COMPLETA"
  // é pack; "TEMPORADA COMPLETA – EPISÓDIO 07" é episódio.
  const html = `
    <p>EPISÓDIO 05 – TEMPORADA COMPLETA</p>
    <p><a href="https://systemads1.com/go/a1">1080p</a></p>
    <p>TEMPORADA COMPLETA – EPISÓDIO 07</p>
    <p><a href="https://systemads1.com/go/a2">720p</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.episode), [null, 7]);
});

// --- Qualidade e fonte normalizadas -------------------------------------

test('bludv: UHD, Full HD, HD e SD sem o sufixo p', () => {
  // O site publica qualidade sem número; o parser antigo só lia \\d{3,4}p/4K.
  const html = `
    <p><a href="${magnet(H1)}">UHD Dublado</a></p>
    <p><a href="${magnet(H2)}">Full HD Dublado</a></p>
    <p><a href="${magnet(H3)}">HD Dublado</a></p>
    <p><a href="${magnet(H4)}">SD Dublado</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.quality), [2160, 1080, 720, 480]);
});

test('bludv: fonte normalizada entra no objeto de link', () => {
  const html = `
    <p>WEB-DL 1080p (2 GB)</p>
    <p><a href="https://systemads1.com/go/w1">Magnet-Link</a></p>
    <p>BluRay 720p (1 GB)</p>
    <p><a href="https://systemads1.com/go/b1">Magnet-Link</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.deepEqual(links.map((l) => l.source), ['WEB-DL', 'BLU-RAY']);
});

// --- cleanPostTitle -------------------------------------------------------

test('bludv: cleanPostTitle tira torrent, resoluções, codec, canais, idioma e vitrine', () => {
  assert.equal(bludv.cleanPostTitle('Matrix Torrent – (1999) BluRay 1080p 5.1 Dublado'), 'Matrix (1999)');
  // &#8211; literal é decodificado antes da limpeza.
  assert.equal(bludv.cleanPostTitle('Coringa Torrent &#8211; (2019) WEB-DL 720p Dual Áudio'), 'Coringa (2019)');
  assert.equal(
    bludv.cleanPostTitle('Duna Parte 2 Torrent (2024) 4K UHD HDR DV Atmos Baixar Grátis'),
    'Duna Parte 2 (2024)',
  );
  // Separadores órfãos que sobram das remoções não sobrevivem.
  assert.equal(bludv.cleanPostTitle('Oppenheimer Torrent – 2023 – 1080p/4K – Dublado'), 'Oppenheimer 2023');
});

test('bludv: releaseTitle leva a fonte para dentro da tag', () => {
  const title = 'Fallout S01 Torrent – (2024) WEB-DL 720p/1080p Dual Áudio';
  assert.equal(
    bludv.releaseTitle(title, { quality: 1080, source: 'WEB-DL', audio: 'dublado', episode: 3, size: null }),
    'Fallout S01 (2024) E03 [1080p WEB-DL DUBLADO]',
  );
  assert.equal(
    bludv.releaseTitle('Oppenheimer Torrent (2023) REMUX 2160p', { quality: 2160, source: 'REMUX', audio: 'dublado', episode: null, size: null }),
    'Oppenheimer (2023) [2160p REMUX DUBLADO]',
  );
  // Sem atributos não há tag — só o título limpo.
  assert.equal(
    bludv.releaseTitle('Matrix Torrent – (1999)', { quality: null, source: null, audio: 'desconhecido', episode: null, size: null }),
    'Matrix (1999)',
  );
});

// --- parsePosts -----------------------------------------------------------

test('bludv: href relativo resolve contra o SITE_URL e card repetido é deduplicado', () => {
  // O assertAllowedUrl descartava href relativo (new URL sem base lança);
  // o tema repete card em widget de relacionados.
  const html = `<div class="posts">
    <div class="post">
      <div class="title"><a href="/duna-parte-2/">Duna Parte 2 Torrent</a></div>
    </div>
    <div class="post">
      <div class="title"><a href="https://bludvfilmes.xyz/duna-parte-2/">Duna Parte 2 Torrent</a></div>
    </div>
  </div>`;
  const posts = bludv.parsePosts(html);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://bludvfilmes.xyz/duna-parte-2/');
});

test('bludv: o último card não herda img/data do rodapé', () => {
  // A janela vai até o próximo <div class="post">; no último card não existe
  // próximo, e sem teto ela varreria o documento inteiro — o rodapé do site
  // tem logo e data de copyright, que virariam poster/date da release.
  const html = `<div class="posts">
    <div class="post">
      <div class="title"><a href="https://bludvfilmes.xyz/ultimo/">Último Torrent</a></div>
    </div>
  </div>
  <footer>${' '.repeat(9000)}
    <img src="https://bludvfilmes.xyz/logo-rodape.png">
    <p>© 01/01/2020 BluDV</p>
  </footer>`;
  const posts = bludv.parsePosts(html);

  assert.equal(posts.length, 1);
  assert.deepEqual({ poster: posts[0].poster, date: posts[0].date }, { poster: null, date: null });
});

// --- Contrato de magnet direto preservado ----------------------------------

test('bludv: magnet direto sem btih válido continua ignorado após a paridade', () => {
  // A paridade não pode afrouxar a validação do 0df38eb: só xt=urn:btih com
  // hash de 40 hex (ou 32 base32) vira botão.
  const html = `
    <p><a href="magnet:?xt=urn:btih:${H1}&dn=ok">1080p Dublado</a></p>
    <p><a href="magnet:?dn=sem-btih">1080p Dublado</a></p>
    <p><a href="magnet:?xt=urn:btih:curto&dn=hash-curto">1080p Dublado</a></p>
  `;
  const links = bludv.parseDownloadLinks(html);

  assert.equal(links.length, 1);
  assert.equal(links[0].url, magnet(H1, 'ok'));
});
