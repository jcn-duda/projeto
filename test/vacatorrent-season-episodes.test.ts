import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Página por-episódio do vacatorrent (layout .ss-ep) e o contrato
// skip-sem-advance da âncora transparente. Extraído de
// vacatorrent-resolver.test.ts pela catraca de linhas.
import vaca from '../vacatorrent-resolver/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'vacatorrent', name), 'utf8');

describe('VacaTorrent Parser: página por-episódio (layout .ss-ep, Temporada 1 real)', () => {
  // Fixture VERBATIM da página real /tv/the-last-of-us/season/temporada-1/
  // (capturada em 2026-09-26): 9 blocos .ss-ep, cada um com a âncora de
  // assistir "Veja Online" (.ss-ep-btn-video, href no host de detalhe) seguida
  // dos botões de download (.ss-ep-btn-dl, protetor systemtech). A página NÃO
  // publica marcador "EPISÓDIO"/SxxEyy — só o número puro do bloco
  // (ss-ep-num / ss-ep-num-inline).
  const base = 'https://vaqueirofilmes.com/tv/the-last-of-us/season/temporada-1/';
  const page = () => fixture('season-episodes.html');

  test('emite SÓ botões de download: contagem = ss-ep-btn-dl da página real', () => {
    const esperados = [...page().matchAll(/ss-ep-btn-dl"/g)].length;
    const links = vaca.parseDownloadLinks(page(), base, { season: 1 });
    assert.equal(esperados, 13, 'fixture real: 9 episódios (4+2+1×7 links)');
    assert.equal(links.length, esperados, 'nenhuma âncora de assistir ou navegação vira item');
    assert.ok(links.every((l) => l.url.startsWith('https://systemtech.space/enc/go.php?id=')), 'todo item é botão do protetor');
    assert.ok(links.every((l) => !/\/episodes\//.test(l.url)), '"Veja Online" (host de detalhe) nunca é emitido');
  });

  test('episódios 1..9 corretos por bloco, com a multiplicidade real de links', () => {
    const links = vaca.parseDownloadLinks(page(), base, { season: 1 });
    assert.deepEqual(links.map((l) => l.episode), [1, 1, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('a primeira "Veja Online" não avança o cursor: o botão 1 herda o bloco 01', () => {
    // Sem a preservação de cursor (contrato skip-sem-advance), o segmento do
    // primeiro botão de download começaria DEPOIS da âncora de assistir e o
    // ss-ep-num "01" (que vem antes dela) seria perdido — episode null.
    const links = vaca.parseDownloadLinks(page(), base, { season: 1 });
    assert.equal(links[0].episode, 1);
    assert.equal((links[0] as any).season, 1);
  });

  test('assistir não emitido mesmo com href no protetor: classificação pela forma da âncora', () => {
    // O player da página /episodes usa o MESMO systemtech dos downloads; o
    // que separa é a âncora (classe -video / texto "Veja Online"), nunca o
    // host — a allowlist do protetor fica intacta.
    const html = `
      <p class="ss-ep-title"><span class="ss-ep-num-inline">07</span> Parentesco</p>
      <a href="https://systemtech.space/enc/go.php?id=PLAYER1" class="ss-ep-btn ss-ep-btn-video">Veja Online</a>
      <a href="https://systemtech.space/enc/go.php?id=DL07" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês • 1080p</a>`;
    const links = vaca.parseDownloadLinks(html, base, { season: 1 });
    assert.equal(links.length, 1);
    assert.ok(links[0].url.includes('DL07'));
    assert.equal(links[0].episode, 7);
  });

  test('skip-sem-advance robusto: passo de episódio que lança no FIM não aborta o parse', () => {
    // Adversarial: no modo tieBreak da vaca o desempate consulta o packMatchAll
    // CRU /i com matchAll, que lança TypeError quando episódio e pack convivem
    // no MESMO sinal. A "Veja Online" no FIM da página vê esse par no segmento
    // dela (depois do último botão de download) — e a âncora transparente não
    // pode abortar o parse: sem a proteção, TODOS os links já coletados se
    // perderiam com o throw. Em erro o estado anterior vale; o caminho de item
    // EMITIDO continua SEM try (teste abaixo).
    const html = `
      <p>Episódio 08</p>
      <a href="https://systemtech.space/enc/go.php?id=DL08" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês 1080p</a>
      <p>Episódio 09</p>
      <a href="https://systemtech.space/enc/go.php?id=DL09" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês 1080p</a>
      <p>Episódio 10 Temporada Completa</p>
      <a href="https://systemtech.space/enc/go.php?id=PLAYER10" class="ss-ep-btn ss-ep-btn-video">Veja Online</a>`;
    const links = vaca.parseDownloadLinks(html, base, { season: 1 });
    assert.equal(links.length, 2, 'os links anteriores sobrevivem à âncora que lança');
    assert.ok(links[0].url.includes('DL08'));
    assert.equal(links[0].episode, 8);
    assert.ok(links[1].url.includes('DL09'));
    assert.equal(links[1].episode, 9);
  });

  test('skip-sem-advance: âncora transparente no MEIO preserva o botão seguinte', () => {
    // Com o cursor preservado, o texto da âncora de assistir cai no segmento
    // do PRÓXIMO botão emitido: o passo de episódio da transparente roda
    // (atualiza o estado, nunca emite) e o botão seguinte é emitido intacto.
    const html = `
      <p>Episódio 07</p>
      <a href="https://systemtech.space/enc/go.php?id=DL07" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês 1080p</a>
      <a href="https://systemtech.space/enc/go.php?id=PLAYER8" class="ss-ep-btn ss-ep-btn-video">Veja Online</a>
      <a href="https://systemtech.space/enc/go.php?id=DL08" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês 1080p</a>`;
    const links = vaca.parseDownloadLinks(html, base, { season: 1 });
    assert.equal(links.length, 2);
    assert.ok(links[0].url.includes('DL07'));
    assert.equal(links[0].episode, 7);
    assert.ok(links[1].url.includes('DL08'));
    assert.equal(links[1].episode, 7, '"Veja Online" não carrega episódio: o botão herda o estado do bloco (âncora transparente)');
  });

  test('caminho de item emitido NÃO engole: segmento de botão com episódio + pack lança', () => {
    // O try/catch é SÓ da âncora transparente (skip-sem-advance). No botão
    // emitido, o mesmo TypeError do desempate sobe — comportamento vivo
    // preservado (o TypeError latente do matchAll não-global é de propósito).
    // Aqui o par mora no segmento DO PRÓPRIO botão; com o cursor preservado, o
    // texto de uma âncora de assistir no meio também chega ao botão seguinte —
    // e lança igual, porque o segmento emitido é um superconjunto.
    const html = `
      <p>Episódio 08 Temporada Completa</p>
      <a href="https://systemtech.space/enc/go.php?id=DLX" class="ss-ep-btn ss-ep-btn-dl">Português | Inglês</a>`;
    assert.throws(() => vaca.parseDownloadLinks(html, base, { season: 1 }), TypeError);
  });

  test('pack único (batch real): episode null — nem o parser nem extractEpisode atribuem número', () => {
    // O batch não tem bloco por-episódio: "S05" no hero não é episódio.
    assert.equal(vaca.extractEpisode('BATCH – Sacrifício de Sangue S05'), null);
    assert.equal(vaca.extractEpisode('Outer Banks 5ª Temporada Completa'), null);
    const links = vaca.parseDownloadLinks(fixture('batch.html'), 'https://vaqueirofilmes.com/batch/batch-sacrificio-de-sangue-s05/', { season: 5 });
    assert.ok(links.length >= 1);
    assert.ok(links.every((l) => l.episode == null), 'pack único nunca herda episódio final indevido');
  });

  test('filme (movie-links) inalterado: Assistir group segue fora e o download preserva contexto', () => {
    const links = vaca.parseDownloadLinks(fixture('movie-links.html'), 'https://vaqueirofilmes.com/movie-links/60009/');
    assert.equal(links.length, 1);
    assert.equal(links[0].size, '2.54 GB');
    assert.equal(links[0].quality, 1080);
    assert.equal(links[0].audio, 'dual');
    assert.equal(links[0].episode, null);
  });
});
