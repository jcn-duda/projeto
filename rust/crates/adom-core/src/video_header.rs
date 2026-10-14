//! Porte de `parseVideoResolution`, `parseMp4Tail`, `isMp4` e
//! `qualityFromResolution` (`src/utils/video-header.ts`) — leitura da resolução
//! real no cabeçalho (MKV/WebM, MP4 com faststart, AVI) ou na cauda (MP4 sem
//! faststart), sem rede/IO.
//!
//! O TS usa só bytes e Number. Pontos de paridade que mordem:
//! - `readUintBE` para no fim do buffer (`pos + i < buf.length`) e acumula em
//!   Number; aqui a acumulação satura em `u64` — qualquer excesso já reprova em
//!   `plausible` (> 16384), então a decisão é a MESMA.
//! - `Math.round(readUintBE(...) / 65536)` vira divisão inteira
//!   `(v + 32768) / 65536` (empate para cima, como o `Math.round` ≥ 0).
//! - O marcador do vint: `0xff >> len` é `0` em `len == 8`; o shift é feito em
//!   `u32` para não estourar o `u8`.
//! - Tamanhos de caixa MP4 de 1 (64 bits) e 0 (até o fim) e as guardas de
//!   `size < header`/`pos + 16 > end` são reproduzidos como no TS.

/// Largura × altura em pixels, como o TS devolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoResolution {
    pub width: u32,
    pub height: u32,
}

const MAX_DIMENSION: u64 = 16384;

/// Dimensões dentro da faixa aceita (0 < d ≤ 16384): fora disso o TS devolve
/// `null`.
fn plausible(width: u64, height: u64) -> Option<VideoResolution> {
    if width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION {
        Some(VideoResolution {
            width: width as u32,
            height: height as u32,
        })
    } else {
        None
    }
}

/// `readUintBE`: big-endian, lendo só os bytes disponíveis (`pos + i < len`) e
/// saturando o acumulador.
fn read_uint_be(buf: &[u8], pos: usize, size: u64) -> u64 {
    let mut value: u64 = 0;
    let mut i: u64 = 0;
    while i < size {
        let idx = pos as u64 + i;
        if idx >= buf.len() as u64 {
            break;
        }
        value = value
            .saturating_mul(256)
            .saturating_add(buf[idx as usize] as u64);
        i += 1;
    }
    value
}

/// `ascii`: quatro bytes (ou zeros quando não cabem — `''` no TS, que nunca casa
/// os literais comparados).
fn ascii(buf: &[u8], pos: usize) -> [u8; 4] {
    if pos + 4 > buf.len() {
        return [0, 0, 0, 0];
    }
    [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]
}

// ---------------------------------------------------------------- Matroska ---
// EBML: Segment → Tracks → TrackEntry → Video → PixelWidth/PixelHeight. Os
// Tracks vêm antes do primeiro Cluster; achar um Cluster sem ter visto vídeo
// encerra a leitura (a mídia já começou).
const EBML_MAGIC: u64 = 0x1a45dfa3;
const ID_SEGMENT: u64 = 0x18538067;
const ID_TRACKS: u64 = 0x1654ae6b;
const ID_TRACK_ENTRY: u64 = 0xae;
const ID_VIDEO: u64 = 0xe0;
const ID_PIXEL_WIDTH: u64 = 0xb0;
const ID_PIXEL_HEIGHT: u64 = 0xba;
const ID_CLUSTER: u64 = 0x1f43b675;

fn vint_length(first: u8) -> usize {
    for i in 0..8 {
        if first & (0x80 >> i) != 0 {
            return i + 1;
        }
    }
    0
}

/// Elemento EBML: `value` já com o bit marcador (é assim que a especificação
/// escreve os IDs).
struct ElementId {
    value: u64,
    len: usize,
}

fn read_element_id(buf: &[u8], pos: usize) -> Option<ElementId> {
    if pos >= buf.len() {
        return None;
    }
    let len = vint_length(buf[pos]);
    if len == 0 || len > 4 || pos + len > buf.len() {
        return None;
    }
    Some(ElementId {
        value: read_uint_be(buf, pos, len as u64),
        len,
    })
}

/// Tamanho EBML: `value: None` é o `-1` do TS (todos os bits em 1 = tamanho
/// desconhecido).
struct ElementSize {
    value: Option<u64>,
    len: usize,
}

fn read_element_size(buf: &[u8], pos: usize) -> Option<ElementSize> {
    if pos >= buf.len() {
        return None;
    }
    let len = vint_length(buf[pos]);
    if len == 0 || pos + len > buf.len() {
        return None;
    }
    // Shift em u32: `0xff >> 8` é 0 no TS e estoura um `u8`.
    let mask = (0xffu32 >> len) as u8;
    let mut value = (buf[pos] & mask) as u64;
    let mut all_ones = (buf[pos] & mask) == mask;
    for offset in 1..len {
        let byte = buf[pos + offset];
        value = value * 256 + byte as u64;
        if byte != 0xff {
            all_ones = false;
        }
    }
    Some(ElementSize {
        value: if all_ones { None } else { Some(value) },
        len,
    })
}

fn read_matroska_video(buf: &[u8], start: usize, end: usize) -> Option<VideoResolution> {
    let mut width: u64 = 0;
    let mut height: u64 = 0;
    let mut pos = start;
    while pos < end {
        let Some(id) = read_element_id(buf, pos) else {
            break;
        };
        let Some(size) = read_element_size(buf, pos + id.len) else {
            break;
        };
        let Some(element_size) = size.value else {
            break; // size.value < 0
        };
        let data = pos + id.len + size.len;
        if id.value == ID_PIXEL_WIDTH {
            width = read_uint_be(buf, data, element_size);
        }
        if id.value == ID_PIXEL_HEIGHT {
            height = read_uint_be(buf, data, element_size);
        }
        pos = data.saturating_add(element_size as usize);
    }
    plausible(width, height)
}

fn walk_matroska(buf: &[u8], start: usize, end: usize, depth: u32) -> Option<VideoResolution> {
    let mut pos = start;
    while pos < end && depth <= 6 {
        let id = read_element_id(buf, pos)?;
        let size = read_element_size(buf, pos + id.len)?;
        let data = pos + id.len + size.len;
        let data_end = match size.value {
            None => end,
            Some(value) => end.min(data.saturating_add(value as usize)),
        };
        if id.value == ID_CLUSTER {
            return None;
        }
        if id.value == ID_VIDEO {
            if let Some(found) = read_matroska_video(buf, data, data_end) {
                return Some(found);
            }
        } else if id.value == ID_SEGMENT || id.value == ID_TRACKS || id.value == ID_TRACK_ENTRY {
            if let Some(found) = walk_matroska(buf, data, data_end, depth + 1) {
                return Some(found);
            }
            // O Segment é o arquivo inteiro: nada depois dele.
            if id.value == ID_SEGMENT {
                return None;
            }
        }
        // Tamanho desconhecido fora do Segment não dá para pular com segurança.
        let value = size.value?;
        pos = data.saturating_add(value as usize);
    }
    None
}

fn parse_matroska(buf: &[u8]) -> Option<VideoResolution> {
    if buf.len() < 4 || read_uint_be(buf, 0, 4) != EBML_MAGIC {
        return None;
    }
    walk_matroska(buf, 0, buf.len(), 0)
}

// --------------------------------------------------------------------- MP4 ---
// ISO BMFF: moov → trak → tkhd, com largura/altura em ponto fixo 16.16. A faixa
// de áudio tem tkhd com 0×0 e é ignorada.
fn is_mp4_container(kind: &[u8; 4]) -> bool {
    matches!(
        kind,
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"edts"
    )
}

/// `Math.round(value / 65536)` para `value` inteiro ≥ 0.
fn round_div_65536(value: u64) -> u64 {
    (value + 32768) / 65536
}

fn walk_mp4(buf: &[u8], start: usize, end: usize, depth: u32) -> Option<VideoResolution> {
    let mut pos = start;
    while pos.saturating_add(8) <= end {
        let mut size = read_uint_be(buf, pos, 4);
        let kind = ascii(buf, pos + 4);
        let mut header = 8usize;
        if size == 1 {
            if pos + 16 > end {
                return None;
            }
            size = read_uint_be(buf, pos + 8, 8);
            header = 16;
        } else if size == 0 {
            size = (end - pos) as u64;
        }
        if size < header as u64 {
            return None;
        }
        let box_end = end.min(pos.saturating_add(size as usize));
        if kind == *b"tkhd" {
            // Guarda de limite: o TS lê `buf[pos + header]` e, quando a caixa
            // termina exatamente no fim do buffer (`pos + header == len`), o
            // Node devolve `undefined`. Como `undefined === 1` é falso, o TS cai
            // no offset de 76 (version ≠ 1); usar `0` reproduz a MESMA decisão
            // sem o índice fora dos limites que fazia o Rust entrar em pânico.
            let version = if pos + header < buf.len() {
                buf[pos + header]
            } else {
                0
            };
            let dims = pos + header + if version == 1 { 88 } else { 76 };
            if dims + 8 <= buf.len() {
                let found = plausible(
                    round_div_65536(read_uint_be(buf, dims, 4)),
                    round_div_65536(read_uint_be(buf, dims + 4, 4)),
                );
                if let Some(res) = found {
                    return Some(res);
                }
            }
        } else if is_mp4_container(&kind) && depth < 6 {
            if let Some(found) = walk_mp4(buf, pos + header, box_end, depth + 1) {
                return Some(found);
            }
        }
        pos = pos.saturating_add(size as usize);
    }
    None
}

/// O arquivo é MP4/MOV (caixa `ftyp` logo no começo).
pub fn is_mp4(head: &[u8]) -> bool {
    head.len() >= 8 && ascii(head, 4) == *b"ftyp"
}

/// MP4 sem faststart guarda o `moov` no FIM: o pedaço do fim começa no meio de
/// alguma caixa, então procura a assinatura `moov` e lê dali.
pub fn parse_mp4_tail(tail: &[u8]) -> Option<VideoResolution> {
    let mut i = 4usize;
    while i + 4 <= tail.len() {
        if tail[i] == 0x6d && ascii(tail, i) == *b"moov" {
            if let Some(found) = walk_mp4(tail, i - 4, tail.len(), 0) {
                return Some(found);
            }
        }
        i += 1;
    }
    None
}

// --------------------------------------------------------------------- AVI ---
// RIFF/AVI: o `avih` (MainAVIHeader) traz dwWidth/dwHeight em little-endian.
fn parse_avi(buf: &[u8]) -> Option<VideoResolution> {
    if ascii(buf, 0) != *b"RIFF" || ascii(buf, 8) != *b"AVI " {
        return None;
    }
    let limit = (buf.len() as i64 - 48).min(64 * 1024);
    let mut i = 12i64;
    while i <= limit {
        let idx = i as usize;
        if buf[idx] == 0x61 && ascii(buf, idx) == *b"avih" {
            let data = idx + 8;
            let le = |p: usize| u32::from_le_bytes([buf[p], buf[p + 1], buf[p + 2], buf[p + 3]]);
            return plausible(le(data + 32) as u64, le(data + 36) as u64);
        }
        i += 1;
    }
    None
}

/// Resolução a partir do COMEÇO do arquivo (MKV/WebM, MP4 com faststart, AVI).
pub fn parse_video_resolution(head: &[u8]) -> Option<VideoResolution> {
    if head.len() < 12 {
        return None;
    }
    parse_matroska(head)
        .or_else(|| {
            if is_mp4(head) {
                walk_mp4(head, 0, head.len(), 0)
            } else {
                None
            }
        })
        .or_else(|| parse_avi(head))
}

/// Rótulo de qualidade pelo MAIOR dos dois eixos: filme em scope tem 1920×800 e
/// é 1080p, HDV tem 1440×1080 e também é.
pub fn quality_from_resolution(width: u32, height: u32) -> Option<&'static str> {
    plausible(width as u64, height as u64)?;
    if width >= 3200 || height >= 1800 {
        return Some("2160p");
    }
    if width >= 1800 || height >= 1000 {
        return Some("1080p");
    }
    if width >= 1200 || height >= 700 {
        return Some("720p");
    }
    if width >= 700 || height >= 460 {
        return Some("480p");
    }
    Some("SD")
}
