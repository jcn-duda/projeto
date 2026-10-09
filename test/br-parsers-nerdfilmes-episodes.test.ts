import { test } from 'node:test';
import assert from 'node:assert/strict';

import nerd from '../nerdfilmes-resolver/server.js';
import { mergeMagnet } from '../src/utils/magnet-bank-merge.js';
import { matchesEpisode } from '../src/utils/format.js';

// NerdFilmes rotula um botão por episódio no PLURAL ("EPISÓDIOS 03") e o par
// de estreia como intervalo ("EPISÓDIOS 01/02"). A regex só aceitava o
// singular: os 9 botões de Widow's Bay (2026-10-04) saíam sem episódio, com o
// título da temporada, e cada um aparecia como pack em TODO episódio.
const BASE = 'https://www.filmesviatorrenthd.net/o-segredo-de-widows-bay-1a-temporada-2026/';
const button = (n: number, label: string) =>
  `<a class="download-btn" href="/link.php?id=blob${n}" target="_blank"><img src="x.png" alt=""> ${label}</a>`;
const HTML = `<h1>O Segredo de Widow&#8217;s Bay 1ª Temporada (2026)</h1><h3>📥 DOWNLOAD VIA TORRENTS</h3>${[
  button(0, '1080p | EPISÓDIOS 01/02 | Dual Áudio'),
  button(1, '1080p | EPISÓDIOS 03 | Dual Áudio'),
  button(2, '1080p | EPISÓDIO 04 | Dual Áudio'),
].join('')}`;

test('nerdfilmes: "EPISÓDIOS 03" é o episódio 3 e "01/02" é intervalo', () => {
  const links = nerd.parseDownloadLinks(HTML, BASE);
  assert.deepEqual(links.map((l) => [l.episode, l.episodeLast ?? null]), [[1, 2], [3, null], [4, null]]);
});

test('nerdfilmes: o título leva o episódio e o addon o lê', () => {
  const post = { title: 'O Segredo de Widow’s Bay 1ª Temporada (2026)' };
  const [par, tres] = nerd.parseDownloadLinks(HTML, BASE);
  const tParDeEstreia = nerd.releaseTitle(post, par);
  const tTres = nerd.releaseTitle(post, tres);
  assert.match(tParDeEstreia, /E01-E02/);
  assert.match(tTres, / E03 /);
  assert.equal(matchesEpisode(tParDeEstreia, { season: 1, episode: 2 }), true);
  assert.equal(matchesEpisode(tParDeEstreia, { season: 1, episode: 3 }), false);
  assert.equal(matchesEpisode(tTres, { season: 1, episode: 1 }), false);
});

test('nerdfilmes (xfilmeshd): "Dublado e Legendado" sai inteiro, sem "e" solto', () => {
  const post = { title: 'O Segredo de Widow’s Bay 1ª Temporada (2026) Dublado e Legendado Download' };
  const [, tres] = nerd.parseDownloadLinks(HTML, BASE);
  assert.equal(nerd.releaseTitle(post, tres), 'O Segredo de Widow’s Bay 1ª Temporada (2026) E03 [1080p DUBLADO]');
});

test('acervo: título sem episódio troca pelo que o nomeia, nunca o contrário', () => {
  const row = (title: string) => ({
    hash: 'a'.repeat(40), uri: '', title, size: 0, isBr: 1, dubbed: 1, quality: '1080p',
    seedersMax: 1, seedersLast: 1, firstSeen: 1, lastSeen: 1, lied: 0,
  });
  const input = (title: string) => ({
    hash: 'a'.repeat(40), uri: '', title, size: 0, isBr: true, dubbed: true, lied: false, quality: '1080p', seedersMax: 1, seedersLast: 1,
  });
  const generico = 'O Segredo de Widow’s Bay 1ª Temporada (2026) [1080p DUBLADO]';
  const nomeado = 'O Segredo de Widow’s Bay 1ª Temporada (2026) E03 [1080p DUBLADO]';
  assert.equal(mergeMagnet(row(generico), input(nomeado), 2).title, nomeado);
  assert.equal(mergeMagnet(row(nomeado), input(generico), 2).title, nomeado);
  // Dois títulos que nomeiam episódio: fica o primeiro (regra antiga).
  assert.equal(mergeMagnet(row(nomeado), input(nomeado.replace('E03', 'E04')), 2).title, nomeado);
});
