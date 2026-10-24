// Resolução real do vídeo lida no CABEÇALHO do arquivo, para quando nem o
// título do release nem o nome do arquivo dizem 720p/1080p. Medido na
// "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS" (2026-09-14): nenhum nome traz
// resolução, a AllDebrid não a informa (o /link/unlock devolve só nome e
// tamanho) e o tamanho não separa 720p de 1080p — 1.53 GB em 127 min dá
// ~1.72 Mbps, a mesma faixa de um YIFY 1080p de 1.50 GB na mesma lista.
//
// Módulo puro: recebe bytes (o começo do arquivo, ou o fim num MP4 sem
// faststart) e devolve largura × altura. Nada de rede aqui.

export interface VideoResolution {
  width: number;
  height: number;
}

const MAX_DIMENSION = 16384;

function plausible(width: number, height: number): VideoResolution | null {
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { width, height } : null;
}

function readUintBE(buf: Uint8Array, pos: number, size: number) {
  let value = 0;
  for (let i = 0; i < size && pos + i < buf.length; i += 1) value = value * 256 + buf[pos + i];
  return value;
}

function ascii(buf: Uint8Array, pos: number) {
  if (pos + 4 > buf.length) return '';
  return String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]);
}

// ---------------------------------------------------------------- Matroska ---
// EBML: Segment → Tracks → TrackEntry → Video → PixelWidth/PixelHeight. Os
// Tracks vêm antes do primeiro Cluster; achar um Cluster sem ter visto vídeo
// encerra a leitura (a mídia já começou).
const EBML_MAGIC = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_VIDEO = 0xe0;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_CLUSTER = 0x1f43b675;

function vintLength(first: number) {
  for (let i = 0; i < 8; i += 1) if (first & (0x80 >> i)) return i + 1;
  return 0;
}

// ID mantém o bit marcador: é assim que a especificação escreve os IDs.
function readElementId(buf: Uint8Array, pos: number) {
  if (pos >= buf.length) return null;
  const len = vintLength(buf[pos]);
  if (!len || len > 4 || pos + len > buf.length) return null;
  return { value: readUintBE(buf, pos, len), len };
}

// Tamanho tira o marcador; todos os bits em 1 = tamanho desconhecido (-1).
function readElementSize(buf: Uint8Array, pos: number) {
  if (pos >= buf.length) return null;
  const len = vintLength(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  const mask = 0xff >> len;
  let value = buf[pos] & mask;
  let allOnes = value === mask;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value: allOnes ? -1 : value, len };
}

function readMatroskaVideo(buf: Uint8Array, start: number, end: number): VideoResolution | null {
  let width = 0;
  let height = 0;
  let pos = start;
  while (pos < end) {
    const id = readElementId(buf, pos);
    const size = id ? readElementSize(buf, pos + id.len) : null;
    if (!id || !size || size.value < 0) break;
    const data = pos + id.len + size.len;
    if (id.value === ID_PIXEL_WIDTH) width = readUintBE(buf, data, size.value);
    if (id.value === ID_PIXEL_HEIGHT) height = readUintBE(buf, data, size.value);
    pos = data + size.value;
  }
  return plausible(width, height);
}

function walkMatroska(buf: Uint8Array, start: number, end: number, depth: number): VideoResolution | null {
  let pos = start;
  while (pos < end && depth <= 6) {
    const id = readElementId(buf, pos);
    const size = id ? readElementSize(buf, pos + id.len) : null;
    if (!id || !size) return null;
    const data = pos + id.len + size.len;
    const dataEnd = size.value < 0 ? end : Math.min(end, data + size.value);
    if (id.value === ID_CLUSTER) return null;
    if (id.value === ID_VIDEO) {
      const found = readMatroskaVideo(buf, data, dataEnd);
      if (found) return found;
    } else if (id.value === ID_SEGMENT || id.value === ID_TRACKS || id.value === ID_TRACK_ENTRY) {
      const found = walkMatroska(buf, data, dataEnd, depth + 1);
      if (found) return found;
      // O Segment é o arquivo inteiro: nada depois dele.
      if (id.value === ID_SEGMENT) return null;
    }
    // Tamanho desconhecido fora do Segment não dá para pular com segurança.
    if (size.value < 0) return null;
    pos = data + size.value;
  }
  return null;
}

function parseMatroska(buf: Uint8Array): VideoResolution | null {
  if (buf.length < 4 || readUintBE(buf, 0, 4) !== EBML_MAGIC) return null;
  return walkMatroska(buf, 0, buf.length, 0);
}

// --------------------------------------------------------------------- MP4 ---
// ISO BMFF: moov → trak → tkhd, com largura/altura em ponto fixo 16.16. A faixa
// de áudio tem tkhd com 0×0 e é ignorada.
const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

function walkMp4(buf: Uint8Array, start: number, end: number, depth: number): VideoResolution | null {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readUintBE(buf, pos, 4);
    const type = ascii(buf, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      size = readUintBE(buf, pos + 8, 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return null;
    const boxEnd = Math.min(end, pos + size);
    if (type === 'tkhd') {
      const version = buf[pos + header];
      const dims = pos + header + (version === 1 ? 88 : 76);
      if (dims + 8 <= buf.length) {
        const found = plausible(Math.round(readUintBE(buf, dims, 4) / 65536), Math.round(readUintBE(buf, dims + 4, 4) / 65536));
        if (found) return found;
      }
    } else if (MP4_CONTAINERS.has(type) && depth < 6) {
      const found = walkMp4(buf, pos + header, boxEnd, depth + 1);
      if (found) return found;
    }
    pos += size;
  }
  return null;
}

/** O arquivo é MP4/MOV (caixa `ftyp` logo no começo). */
function isMp4(head: Uint8Array) {
  return head.length >= 8 && ascii(head, 4) === 'ftyp';
}

/**
 * MP4 sem faststart guarda o `moov` no FIM: o pedaço do fim começa no meio de
 * alguma caixa, então procura a assinatura `moov` e lê dali.
 */
function parseMp4Tail(tail: Uint8Array): VideoResolution | null {
  for (let i = 4; i + 4 <= tail.length; i += 1) {
    if (tail[i] !== 0x6d || ascii(tail, i) !== 'moov') continue;
    const found = walkMp4(tail, i - 4, tail.length, 0);
    if (found) return found;
  }
  return null;
}

// --------------------------------------------------------------------- AVI ---
// RIFF/AVI: o `avih` (MainAVIHeader) traz dwWidth/dwHeight em little-endian.
function parseAvi(buf: Uint8Array): VideoResolution | null {
  if (ascii(buf, 0) !== 'RIFF' || ascii(buf, 8) !== 'AVI ') return null;
  const limit = Math.min(buf.length - 48, 64 * 1024);
  for (let i = 12; i <= limit; i += 1) {
    if (buf[i] !== 0x61 || ascii(buf, i) !== 'avih') continue;
    const data = i + 8;
    const le = (p: number) => buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24);
    return plausible(le(data + 32) >>> 0, le(data + 36) >>> 0);
  }
  return null;
}

/** Resolução a partir do COMEÇO do arquivo (MKV/WebM, MP4 com faststart, AVI). */
function parseVideoResolution(head: Uint8Array): VideoResolution | null {
  if (!head || head.length < 12) return null;
  return parseMatroska(head) || (isMp4(head) ? walkMp4(head, 0, head.length, 0) : null) || parseAvi(head);
}

/**
 * Rótulo de qualidade pelo MAIOR dos dois eixos: filme em scope tem 1920×800 e
 * é 1080p, HDV tem 1440×1080 e também é.
 */
function qualityFromResolution(width: number, height: number): string | null {
  if (!plausible(width, height)) return null;
  if (width >= 3200 || height >= 1800) return '2160p';
  if (width >= 1800 || height >= 1000) return '1080p';
  if (width >= 1200 || height >= 700) return '720p';
  if (width >= 700 || height >= 460) return '480p';
  return 'SD';
}

export { parseVideoResolution, parseMp4Tail, isMp4, qualityFromResolution };
