// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// nome do stream — toStremioStream, layout compacto da coluna estreita,
// encurtamento do rótulo da fonte, edition, prefixo do debrid e
// streamDisplayName (estilo e opções do runtime).
import { test } from 'node:test';
import assert from 'node:assert';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import {
  streamDisplayName,
  markDebridName,
  toStremioStream,
} from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// O retorno de toStremioStream é `Stream | null` (null quando falta hash) e os
// campos de exibição são opcionais no tipo; todos os casos abaixo passam hash
// válido e os tocam, então o wrapper local só documenta o invariante — em vez
// de um cast no lugar em 40+ chamadas.
type TestStream = Stream & { infoHash: string; name: string; title: string; behaviorHints: { bingeGroup: string } };
const stremioStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

test('toStremioStream normaliza e guarda campos internos', () => {
  const s = stremioStream({
    title: 'Coringa 1080p BluRay',
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    seeders: 42,
    size: 2147483648,
    tracker: '1337x',
  });
  assert.equal(s.infoHash, HASH);
  assert.equal(s._seeders, 42);
  assert.equal(s._quality, '1080p');
  assert.equal(s._br, false);
  assert.ok(s.title.includes('2.00 GB'));
  assert.ok(s.title.includes('1337x'));
  // A coluna estreita leva só o resumo; a release inteira mora no `title`.
  assert.equal(s.name, '1080p BluRay · 1337x · 👤 42');
  assert.equal(s._tracker, '1337x');
  assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
  // Sem hash não há stream.
  assert.equal(toStremioStream({ title: 'sem magnet' }), null);
});

test('toStremioStream preserva a marca de origem BR do provider', () => {
  const s = stremioStream({ title: 'Coringa Dublado', infoHash: HASH, isBr: true, seeders: 1 });
  assert.equal(s._br, true);
  assert.equal(s.name, 'DUB BR · 👤 1');
});

test('name traz release e seeds; a coluna larga não duplica marcadores', () => {
  const release = 'Sinners.2025.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-HONE';
  const s = stremioStream({
    title: release,
    infoHash: HASH,
    seeders: 181,
    size: 23.99 * 1024 ** 3,
    tracker: 'The Pirate Bay',
  });

  // A release NÃO se repete na coluna estreita: com ela ali, este item sozinho
  // ocupava 11 linhas de altura no Stremio.
  assert.equal(s.name, '4K WEB-DL · The Pirate Bay · 👤 181');
  assert.equal(s.name.includes(release), false);
  assert.equal(s.title.split('\n')[0], release);
  assert.match(s.title, /👤 181/);
  assert.match(s.title, /💾 23\.99 GB/);
  assert.match(s.title, /⚙️ The Pirate Bay/);
  for (const marker of ['👤', '💾', '⚙️']) {
    assert.equal(s.title.split(marker).length - 1, 1, `${marker} aparece uma vez`);
  }
});

test('layout compacto diferencia áudio e origem sem inferir dublado', () => {
  const brUnknown = stremioStream({ title: 'Pecadores 2025', infoHash: HASH, isBr: true });
  const dual = stremioStream({ title: 'Pecadores 1080p Dual Audio', infoHash: OTHER, isBr: true });
  const legendado = stremioStream({ title: 'Sinners 720p Legendado', infoHash: 'c'.repeat(40) });

  // Sem seeders publicados (padrão das fontes BR) a linha não inventa "👤 0".
  assert.equal(brUnknown.name, 'BR');
  assert.equal(dual.name, '1080p DUAL BR');
  assert.equal(legendado.name, '720p LEG');
});

test('a coluna estreita cabe numa linha; STREAM_NAME_STYLE=full devolve a antiga', () => {
  // Caso real medido na tela: com a release no `name`, este item ocupava 11
  // linhas de altura no Stremio e cabiam três streams na lista inteira.
  const release = 'Mestres do Universo (2026) 5.1 WEB-DL | [2160p WEB-DL DUBLADO 20.17 GB]';
  const item = { title: release, infoHash: HASH, seeders: 1, size: 20.17 * 1024 ** 3, tracker: 'TorrentDosFilmes', isBr: true };

  const compacto = stremioStream(item);
  assert.equal(compacto.name, '4K WEB-DL DUB BR · TorrentDos · 👤 1');
  assert.equal(compacto.name.includes('\n'), false, 'nada de quebra na coluna estreita');
  // A fonte é limitada antes de entrar na coluna estreita, para não esconder
  // qualidade nem seeders mesmo quando o indexer usa um domínio longo.
  assert.ok(compacto.name.includes('TorrentDos'));
  // Nada se perde: a release e os metadados continuam na coluna larga.
  assert.equal(compacto.title.split('\n')[0], release);
  assert.match(compacto.title, /💾 20\.17 GB/);

  const original = config.streamNameStyle;
  try {
    config.streamNameStyle = 'full';
    assert.equal(stremioStream(item).name, `${release}\n4K WEB-DL DUB BR · TorrentDos · 👤 1`);
  } finally {
    config.streamNameStyle = original;
  }
});

test('fonte no name remove TLD, não cria separador órfão e pode ser desligada', () => {
  const item = {
    title: 'Filme 1080p BluRay',
    infoHash: HASH,
    tracker: 'kickasstorrents.to',
    seeders: 1,
  };

  assert.equal(stremioStream(item).name, '1080p BluRay · kickass · 👤 1');
  assert.equal(
    stremioStream({ title: 'Filme 1080p BluRay', infoHash: OTHER, seeders: 1 }).name,
    '1080p BluRay · 👤 1',
  );

  const original = config.streamNameShowSource;
  try {
    config.streamNameShowSource = false;
    assert.equal(stremioStream(item).name, '1080p BluRay · 👤 1');
  } finally {
    config.streamNameShowSource = original;
  }
});

test('o rótulo da fonte encurta por regra, preferindo fronteira ao corte no meio', () => {
  // Nome truncado no meio ("kickasstorrent", "TorrentDosFilm") o usuário lê como
  // se fosse outra fonte — pior que nome curto. A escada tenta, nesta ordem:
  // TLD, sufixo "torrent(s)", fronteira (separador ou camelCase) e só então o
  // corte seco.
  const label = (tracker: any) =>
    stremioStream({ title: 'Filme 1080p BluRay', infoHash: HASH, seeders: 1, tracker })
      .name.split(' · ')[1];

  // Cabe inteiro: nada é tocado (inclusive com espaços e ponto no meio).
  assert.equal(label('Bludv'), 'Bludv');
  assert.equal(label('RedeTorrent'), 'RedeTorrent');
  assert.equal(label('HDRTorrent'), 'HDRTorrent');
  assert.equal(label('The Pirate Bay'), 'The Pirate Bay');
  // TLD sai mesmo quando o resto já cabia.
  assert.equal(label('1337x.to'), '1337x');
  assert.equal(label('yts.mx'), 'yts');
  // Só o TLD não basta: o sufixo "torrents" é a parte que menos identifica.
  assert.equal(label('kickasstorrents.to'), 'kickass');
  assert.equal(label('ComandoTorrents'), 'Comando');
  // Sem sufixo removível, corta na fronteira camelCase.
  assert.equal(label('NerdFilmesTorrent'), 'NerdFilmes');
  assert.equal(label('TorrentDosFilmes'), 'TorrentDos');
  // Fronteira por separador vale igual, desde que caiba na janela.
  assert.equal(label('rede-torrent-brasil'), 'rede-torrent');
  assert.equal(label('nerd filmes torrent hd'), 'nerd filmes');
  // Sem TLD, sem sufixo e sem fronteira ANTES do teto, o corte seco é o menos
  // ruim: a fronteira de "torrentdosfilmes-v2" só aparece no char 16.
  assert.equal(label('torrentdosfilmes-v2.xyz'), 'torrentdosfilm');
  assert.equal(label('abcdefghijklmnopqrst'), 'abcdefghijklmn');
  // Fronteira cedo demais não vale: "Ab" sozinho não identifica fonte nenhuma.
  assert.equal(label('AbCdefghijklmnopqrs'), 'AbCdefghijklmn');
});

test('quatro releases 4K do mesmo filme não podem sair com a linha idêntica', () => {
  // Caso real (I Am Legend): a lista trazia quatro 4K em que só o número de
  // seeders mudava. Duas delas são CORTES DIFERENTES do filme — escolher pelo
  // maior seed levava ao final alternativo sem o usuário saber.
  const releases: Array<[string, number]> = [
    ['I Am Legend 2007 Theatrical UHD BluRay 1080p DD 5 1 DV HDR x265-SQS', 35],
    ['I Am Legend 2007 Alternate Ending 2160p 4K UHD BluRay h2', 27],
    ['I.Am.Legend.2007.2160p.MA.WEB-DL.DDP5.1.H.265-PandaQT SDR 4k UHD', 18],
    ['I Am Legend 2007 UHD BluRay 2160p HDR10 DV HEVC DTS HD MA 5 1 x26', 12],
  ];
  const nomes = releases.map(([title, seeders], i) =>
    stremioStream({ title, infoHash: String(i).repeat(40).slice(0, 40), seeders }).name,
  );

  assert.deepEqual(nomes, [
    '4K Cinema BluRay · 👤 35',
    '4K Alt.End BluRay · 👤 27',
    '4K WEB-DL · 👤 18',
    '4K BluRay · 👤 12',
  ]);
  // Sem os seeders, os rótulos ainda precisam se distinguir: o seed é desempate,
  // não identidade.
  const semSeed = nomes.map((n) => n.split(' · ')[0]);
  assert.equal(new Set(semSeed).size, semSeed.length, `rótulos repetidos: ${semSeed.join(' | ')}`);
  // E continua curto — o motivo de ter encurtado não pode ser desfeito aqui.
  assert.ok(Math.max(...nomes.map((n) => n.length)) <= 32);
});

test('release que não anuncia nada mostra o título em vez de só os seeders', () => {
  // Sem resolução, corte, fonte nem áudio sobraria "👤 3", que não identifica
  // nada — e nesse caso o nome da release é a única informação que existe.
  const nada = stremioStream({ title: 'I Am Legend 2007 [MissouriMike]', infoHash: HASH, seeders: 3 });
  assert.equal(nada.name, 'I Am Legend 2007 [MissouriMike]\n👤 3');

  const s = stremioStream({ title: 'Filme Obscuro', infoHash: OTHER, seeders: 0 });
  assert.equal(s.name, 'Filme Obscuro');

  // Basta UM atributo para o resumo valer e o título sair da coluna estreita.
  const comFonte = stremioStream({ title: 'Filme Obscuro BluRay', infoHash: HASH, seeders: 3 });
  assert.equal(comFonte.name, 'BluRay · 👤 3');
});

// Formato do Torrentio, com ⚡ no lugar do "+": a sigla é do DEBRID, não do
// addon. O "[PM+]" fixo de antes prometia play instantâneo até para quem estava
// em P2P puro, e o PM colidia com a sigla do Premiumize.
test('prefixo do debrid distingue cache de download sem deslocar a qualidade', () => {
  const name = 'Coringa 2019 1080p BluRay\n1080p DUB BR · 👤 42';
  assert.equal(markDebridName(name, 'AD', true), `[AD⚡] ${name}`);
  assert.equal(markDebridName(name, 'AD', false), `[AD download] ${name}`);
  assert.equal(markDebridName(name, 'PM', true), `[PM⚡] ${name}`);
  // Sem debrid não há prefixo: não há nada a prometer sobre o play.
  assert.equal(markDebridName(name, '', true), name);
  assert.equal(markDebridName(name, '   ', false), name);
});

test('streamDisplayName formata detalhes compactos, omite ou inclui tracker e respeita style full', () => {
  const nameCompact = streamDisplayName({
    title: 'Movie.2024.1080p.WEB-DL.DUAL',
    quality: '1080p',
    audio: 'Dual',
    source: 'WEB-DL',
    tracker: 'bludv',
    isBr: true,
    seeders: 15,
  });
  assert.match(nameCompact, /1080p WEB-DL DUAL BR · bludv · 👤 15/);

  const nameNoSource = streamDisplayName({
    title: 'Movie.2024.1080p.WEB-DL.DUAL',
    quality: '1080p',
    audio: 'Dual',
    source: 'WEB-DL',
    tracker: 'bludv',
    isBr: true,
    seeders: 15,
    showSource: false,
  });
  assert.equal(nameNoSource.includes('bludv'), false);
  assert.match(nameNoSource, /1080p WEB-DL DUAL BR · 👤 15/);

  const nameFull = streamDisplayName({
    title: 'Movie.2024.1080p.WEB-DL.DUAL',
    quality: '1080p',
    audio: 'Dual',
    source: 'WEB-DL',
    tracker: 'bludv',
    isBr: true,
    seeders: 15,
    style: 'full',
  });
  assert.match(nameFull, /^Movie\.2024\.1080p\.WEB-DL\.DUAL\n1080p WEB-DL DUAL BR · bludv · 👤 15$/);
});

test('streamDisplayName consome opções do runtime quando em contexto assíncrono', () => {
  const rawOpts = runtime.normalize({ ns: 'full', st: 0 });
  runtime.run({ opts: rawOpts }, () => {
    const name = streamDisplayName({
      title: 'Movie.Title.2024.2160p',
      quality: '2160p',
      tracker: 'yts',
      seeders: 5,
    });
    assert.match(name, /^Movie\.Title\.2024\.2160p\n4K · 👤 5$/);
    assert.equal(name.includes('yts'), false);
  });
});

