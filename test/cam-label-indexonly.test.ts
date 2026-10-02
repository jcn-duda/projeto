// MagnetDownload como index-only e rótulo CAM vindo do dn= do magnet.
// Extraído de hdr-budget-cam-label.test.ts pelo orçamento de 400 linhas; o
// contrato e os casos medidos são os mesmos.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { inputFromItem } from '../src/utils/magnet-bank-merge.js';
import { UNKNOWN_QUALITY } from '../src/utils/audio-quality.js';
import { dedupeByHash } from '../src/utils/stream-ranking.js';
import type { RawItem } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const magnetUri = (dn: string) => `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(dn)}`;

describe('Fase 2: MagnetDownload → indexOnlyIndexers', () => {
  test('magnetdownload está em indexOnlyIndexers e fora de slowIndexers', () => {
    const cfg = config.jackett;
    assert.ok(
      cfg.indexOnlyIndexers.includes('magnetdownload'),
      'magnetdownload está em indexOnlyIndexers',
    );
    assert.ok(
      !cfg.slowIndexers.includes('magnetdownload'),
      'magnetdownload NÃO está em slowIndexers',
    );
  });

  test('hdrtorrent-cardigann está em ambas as listas (slow + index-only)', () => {
    const cfg = config.jackett;
    assert.ok(cfg.slowIndexers.includes('hdrtorrent-cardigann'),
      'hdrtorrent-cardigann está em slowIndexers (busca ao vivo com SWR)');
    assert.ok(cfg.indexOnlyIndexers.includes('hdrtorrent-cardigann'),
      'hdrtorrent-cardigann está em indexOnlyIndexers (colhedor)');
  });
});

// ─── Fase 3: Rótulo CAM honesto ──────────────────────────────────────────────

describe('Fase 3: Rótulo CAM do magnet', () => {
  test('toStremioStream: título limpo + dn CAMRip → fonte CAM', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      magnet: magnetUri('Resident.Evil.2026.1080p.CAMRip.x264'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // O nome do stream contém "CAM" porque o dn= revela a gravação.
    assert.match(String(stream!.name), /CAM/, `o nome do stream contém CAM: "${stream!.name}"`);
  });

  test('toStremioStream: título com CAM + dn limpo → fonte CAM (título vence)', () => {
    const item: RawItem = {
      title: 'Resident.Evil.2026.CAMRip.1080p',
      magnet: magnetUri('Resident.Evil.2026.1080p.WEB-DL'),
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // O título diz CAM → a fonte é CAM (o título é o caminho default).
    assert.match(String(stream!.name), /CAM/, `CAM pelo título: "${stream!.name}"`);
  });

  test('toStremioStream: título limpo + dn limpo → fonte do título', () => {
    const item: RawItem = {
      title: 'Filme.2026.1080p.BluRay.x264',
      magnet: magnetUri('Filme.2026.1080p.BluRay.x264'),
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    assert.match(String(stream!.name), /BluRay/, `fonte do título: "${stream!.name}"`);
  });

  test('toStremioStream: título limpo + sem magnet → fonte vazia', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      infoHash: HASH,
      seeders: 10,
    };
    const stream = toStremioStream(item);
    assert.ok(stream, 'stream não é null');
    // Sem magnet e sem fonte no título → fonte vazia (não mente).
    assert.doesNotMatch(String(stream!.name), /CAM|BluRay|WEB/, `sem fonte: "${stream!.name}"`);
  });

  test('magnet-bank-merge: magnet com CAMRip preserva evidência no título', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      magnet: magnetUri('Resident.Evil.2026.1080p.CAMRip.x264'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    // O título armazenado é o dn= do magnet (que contém CAMRip), não o
    // título limpo do post. Assim a evidência CAM sobrevive no banco.
    assert.match(result!.magnet.title, /CAMRip/i,
      `título armazenado revela CAM: "${result!.magnet.title}"`);
  });

  test('magnet-bank-merge: magnet sem CAM não muda o título', () => {
    const item: RawItem = {
      title: 'Filme.2026.1080p.BluRay',
      magnet: magnetUri('Filme.2026.1080p.BluRay'),
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    // Sem CAM no magnet, o título do post é preservado.
    assert.equal(result!.magnet.title, 'Filme.2026.1080p.BluRay');
  });

  test('magnet-bank-merge: sem magnet, título do post é preservado', () => {
    const item: RawItem = {
      title: 'Resident Evil (2026) [1080p 2.60 GB]',
      infoHash: HASH,
      seeders: 10,
      indexer: 'comandotorrents',
    };
    const result = inputFromItem(item, 'comandotorrents');
    assert.ok(result, 'inputFromItem devolveu resultado');
    assert.equal(result!.magnet.title, 'Resident Evil (2026) [1080p 2.60 GB]');
  });

  test('dedupeByHash/relabel: título limpo + _magnetDn CAMRip mantém CAM no name', () => {
    // Merge força relabel (qualidade do loser preenche unknown do winner).
    const winner = {
      infoHash: HASH,
      title: 'Resident Evil (2026) [1080p LEGENDADO]',
      name: 'Resident Evil\n👤 50',
      _quality: UNKNOWN_QUALITY,
      _seeders: 50,
      _magnetDn: 'Resident.Evil.2026.1080p.CAMRip.x264',
      _br: false,
      _dubbed: false,
      _tracker: 'kickass',
      _indexer: 'kickasstorrents',
    };
    const loser = {
      infoHash: HASH,
      title: 'Resident Evil (2026) 1080p WEB-DL',
      name: 'Resident Evil\n👤 5',
      _quality: '1080p',
      _seeders: 5,
      _magnetDn: '',
      _br: false,
      _dubbed: false,
      _tracker: 'tpb',
      _indexer: 'thepiratebay',
    };
    const [merged] = dedupeByHash([winner, loser]);
    assert.equal(merged._magnetDn, winner._magnetDn, '_magnetDn sobrevive ao merge');
    assert.match(String(merged.name), /CAM/, `relabel preserva CAM: "${merged.name}"`);
  });
});
