// Resolução lida no cabeçalho do vídeo, para release cujo título e arquivo não
// dizem 720p/1080p (FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS, 2026-09-14).
// Os buffers são montados à mão com a estrutura mínima de cada formato.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVideoResolution, parseMp4Tail, isMp4, qualityFromResolution } from '../src/utils/video-header.js';

const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());
const asciiBytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// EBML: ID com marcador, tamanho vint mínimo.
const ebmlId = (id: number) => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
};
const ebmlSize = (n: number) => (n < 0x7f ? [0x80 | n] : [0x40 | (n >> 8), n & 0xff]);
const el = (id: number, payload: number[]) => [...ebmlId(id), ...ebmlSize(payload.length), ...payload];
const uint16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

function matroska(width: number, height: number) {
  const audioTrack = el(0xae, [...el(0xd7, [1]), ...el(0xe1, el(0x9f, [2]))]);
  const videoTrack = el(0xae, [...el(0xd7, [2]), ...el(0xe0, [...el(0xb0, uint16(width)), ...el(0xba, uint16(height))])]);
  const segmentBody = [...el(0x1549a966, el(0x2ad7b1, [0x0f, 0x42, 0x40])), ...el(0x1654ae6b, [...audioTrack, ...videoTrack]), ...el(0x1f43b675, [0, 0, 0])];
  return bytes(
    el(0x1a45dfa3, el(0x4282, asciiBytes('matroska'))),
    // Segment com tamanho desconhecido, como nos arquivos gravados ao vivo.
    [...ebmlId(0x18538067), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    segmentBody,
  );
}

const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...asciiBytes(type), ...payload];
const tkhd = (width: number, height: number) => box('tkhd', [0, 0, 0, 0, ...new Array(72).fill(0), ...u32be(width * 65536), ...u32be(height * 65536)]);
const moov = (width: number, height: number) => box('moov', [...box('trak', tkhd(0, 0)), ...box('trak', tkhd(width, height))]);
const ftyp = box('ftyp', asciiBytes('isomiso2'));

test('MKV: lê PixelWidth/PixelHeight da faixa de vídeo e ignora a de áudio', () => {
  const res = parseVideoResolution(matroska(1920, 800));
  assert.deepEqual(res, { width: 1920, height: 800 });
  assert.equal(qualityFromResolution(res!.width, res!.height), '1080p');
});

test('MP4 com faststart: moov no começo, tkhd do vídeo em 16.16', () => {
  const head = bytes(ftyp, moov(1280, 534), box('mdat', [1, 2, 3]));
  assert.ok(isMp4(head));
  assert.deepEqual(parseVideoResolution(head), { width: 1280, height: 534 });
});

test('MP4 sem faststart: o começo não tem moov, o pedaço do fim tem', () => {
  // mdat gigante logo depois do ftyp: o começo não alcança o moov.
  const head = bytes(ftyp, [...u32be(50 * 1024 ** 2), ...asciiBytes('mdat')], new Array(64).fill(7));
  assert.equal(parseVideoResolution(head), null);
  assert.ok(isMp4(head), 'o chamador sabe que precisa buscar o fim');
  // O pedaço do fim começa no meio do mdat.
  const tail = bytes(new Array(37).fill(9), moov(3840, 1600));
  const res = parseMp4Tail(tail);
  assert.deepEqual(res, { width: 3840, height: 1600 });
  assert.equal(qualityFromResolution(res!.width, res!.height), '2160p');
});

test('AVI: dwWidth/dwHeight do avih em little-endian', () => {
  const avih = [...asciiBytes('avih'), ...u32le(56), ...new Array(32).fill(0), ...u32le(720), ...u32le(480), ...new Array(16).fill(0)];
  const avi = bytes(asciiBytes('RIFF'), u32le(1000), asciiBytes('AVI '), asciiBytes('LIST'), u32le(68), asciiBytes('hdrl'), avih);
  const res = parseVideoResolution(avi);
  assert.deepEqual(res, { width: 720, height: 480 });
  assert.equal(qualityFromResolution(res!.width, res!.height), '480p');
});

test('bytes que não são vídeo, ou cortados, não inventam resolução', () => {
  assert.equal(parseVideoResolution(Uint8Array.from(asciiBytes('<html>not a video file at all</html>'))), null);
  assert.equal(parseVideoResolution(matroska(1920, 1080).subarray(0, 40)), null);
  assert.equal(parseVideoResolution(new Uint8Array(0)), null);
});

test('qualidade pelo maior eixo: scope e HDV não caem uma faixa', () => {
  assert.equal(qualityFromResolution(3840, 2160), '2160p');
  assert.equal(qualityFromResolution(1920, 800), '1080p');
  assert.equal(qualityFromResolution(1440, 1080), '1080p');
  assert.equal(qualityFromResolution(1280, 720), '720p');
  assert.equal(qualityFromResolution(1280, 534), '720p');
  assert.equal(qualityFromResolution(720, 480), '480p');
  assert.equal(qualityFromResolution(640, 360), 'SD');
  assert.equal(qualityFromResolution(0, 1080), null);
});
