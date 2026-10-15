//! Porte puro de `src/providers/duplicate-pack.ts`.
//!
//! Pack que repete, byte a byte, o arquivo de uma release avulsa da MESMA
//! lista — duas linhas para o mesmo arquivo; some o PACK, nunca o avulso. Nada
//! aqui conhece cache/debrid: a lista de arquivos CHEGA LIDA (o
//! `peekFileSizes` do Node, por hash) e o `cached` é o conjunto de hashes que a
//! checagem de cache já provou ⚡.
//!
//! Paridades ansiosas do porte:
//! - O `VIDEO_RE` aqui é o LOCAL do duplicate-pack (mais largo que o
//!   `VIDEO_EXT` do file-selector: aceita `wmv|m2ts|mpg|mpeg`), regex distinto
//!   no TS — não unificar.
//! - `pickFile` roda em erro/lista vazia → `catch` → `null` (pack não medido).
//! - Vídeo ÚNICO com tamanho 0 AINDA é medido (`bytes: 0`): entra no mapa de
//!   avulsos com chave 0, fiel ao TS — só o pack exige bytes > 0.
//! - Sem lista de arquivos, o total do torrent (`_bytes`) só vale como tamanho
//!   do vídeo para release AVULSA: pack sem lista nunca é medido.
//! - `cached.has(s.hash) || !cached.has(m.hash)`: não se troca play
//!   instantâneo por download — o avulso precisa estar tão pronto quanto o pack.
//! - `dropTrace(trace, stream, 'duplicate-file')` vira `TraceDrop` na saída
//!   (mesmo contrato de `stream_ranking_dedupe`); `metrics.count` é Node-side.

use std::collections::{HashMap, HashSet};

use fancy_regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

use crate::br_origin::js_canon;
use crate::debrid::{pick_file, DebridFile, PlayHint, WorkHint};
use crate::stream_ranking_types::{RankingStream, TraceDrop};

fn video_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(r"\.(MKV|MP4|AVI|M4V|MOV|WMV|TS|M2TS|WEBM|MPG|MPEG)$")
            .expect("regex VIDEO_RE do duplicate-pack compila")
    })
}

fn is_video_dup(path: &str) -> bool {
    video_re().is_match(&js_canon(path)).unwrap_or(false)
}

/// Entrada do corte. `files` é a caixa do `peekFileSizes` do Node: chave é o
/// hash MINÚSCULO (o `recordFileSizes` baixa antes de gravar) e o valor é a
/// lista já FILTRADA (tamanho > 0, vídeo pelo VIDEO_EXT do seletor, sem
/// sample, sem propaganda). `cached` contém os hashes provados ⚡ (minúsculos).
#[derive(Debug, Clone, Default)]
pub struct DuplicatePackInput {
    pub streams: Vec<RankingStream>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Dica de obra `w` do play (`work.n` / `work.y` do TS).
    pub work_names: Vec<String>,
    pub work_year: Option<i64>,
    pub cached: HashSet<String>,
    pub files: HashMap<String, Vec<DebridFile>>,
}

/// Saída: lista sem os packs repetidos + os cortes no formato do `dropTrace`.
#[derive(Debug, Clone, Default)]
pub struct DuplicatePackOutput {
    pub streams: Vec<RankingStream>,
    pub drops: Vec<TraceDrop>,
}

struct Measured {
    index: usize,
    hash: String,
    bytes: f64,
    pack: bool,
}

/// `Boolean(_br ?? isBr)` do `dropTrace` (nullish: `_br: false` presente vence).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(title || name || '').split('\n')[0]` — o `labelOf` do trace.
fn label_of(s: &RankingStream) -> String {
    let title = s.title.clone().unwrap_or_default();
    let base = if !title.is_empty() {
        title
    } else {
        s.name.clone().unwrap_or_default()
    };
    base.split('\n').next().unwrap_or("").to_string()
}

fn trace_drop_of(s: &RankingStream) -> TraceDrop {
    let br = s.br.unwrap_or_else(|| truthy(s.extra.get("isBr")));
    TraceDrop {
        reason: "duplicate-file".to_string(),
        label: label_of(s),
        br,
        dubbed: s.dubbed,
        quality: s.quality.clone().filter(|q| !q.is_empty()),
    }
}

/// Bytes do arquivo que o play tocaria, e se o torrent é um pack (2+ vídeos).
fn measure(index: usize, s: &RankingStream, input: &DuplicatePackInput) -> Option<Measured> {
    let raw_hash = s.info_hash.as_deref().filter(|h| !h.is_empty())?;
    let hash = raw_hash.to_lowercase();
    let files = input.files.get(&hash).map(Vec::as_slice);
    let videos: Vec<&DebridFile> = files
        .map(|fs| fs.iter().filter(|f| is_video_dup(&f.path)).collect())
        .unwrap_or_default();
    if let Some(fs) = files {
        if videos.len() >= 2 {
            // Mesma dica do play: S/E pedido, ou obra com nomes (pack multiobra).
            let hint = if input.season.is_some() {
                PlayHint {
                    season: input.season,
                    episode: input.episode,
                    work: None,
                    dubbed: false,
                }
            } else if !input.work_names.is_empty() {
                PlayHint {
                    season: None,
                    episode: None,
                    dubbed: false,
                    work: Some(WorkHint {
                        names: input.work_names.clone(),
                        year: input.work_year,
                        pack: true,
                    }),
                }
            } else {
                PlayHint::default()
            };
            // `Number(pickFile(...)?.size) || 0`, com o `catch` virando `null`.
            let bytes = match pick_file(fs, &hint) {
                crate::debrid::PickOutcome::File { size, .. } => {
                    if size.is_nan() || size == 0.0 {
                        0.0
                    } else {
                        size
                    }
                }
                _ => 0.0,
            };
            return if bytes > 0.0 {
                Some(Measured {
                    index,
                    hash,
                    bytes,
                    pack: true,
                })
            } else {
                None
            };
        }
    }
    if videos.len() == 1 {
        let bytes = videos[0].size;
        let bytes = if bytes.is_nan() || bytes == 0.0 {
            0.0
        } else {
            bytes
        };
        // Vídeo único é medido MESMO com bytes 0: entra nos avulsos com
        // chave 0, como no TS.
        return Some(Measured {
            index,
            hash,
            bytes,
            pack: false,
        });
    }
    // Sem lista de arquivos: o total do torrent só vale como tamanho do vídeo
    // para release avulsa — um pack sem lista nunca é medido.
    let bytes = match s.bytes {
        Some(b) if b.is_finite() && b != 0.0 => b,
        _ => 0.0,
    };
    if bytes > 0.0 {
        Some(Measured {
            index,
            hash,
            bytes,
            pack: false,
        })
    } else {
        None
    }
}

pub fn drop_duplicate_pack_files(input: &DuplicatePackInput) -> DuplicatePackOutput {
    let measured: Vec<Option<Measured>> = input
        .streams
        .iter()
        .enumerate()
        .map(|(i, s)| measure(i, s, input))
        .collect();

    let mut drop: Vec<usize> = Vec::new();
    for m in &measured {
        let Some(m) = m else { continue };
        if !m.pack {
            continue;
        }
        // Primeiro avulso do tamanho exato com hash diferente e "tão pronto
        // quanto" o pack (⚡ no avulso, ou nenhum dos dois ⚡).
        let twin = measured.iter().any(|s| {
            let Some(s) = s else { return false };
            !s.pack
                && s.bytes == m.bytes
                && s.hash != m.hash
                && (input.cached.contains(&s.hash) || !input.cached.contains(&m.hash))
        });
        if twin {
            drop.push(m.index);
        }
    }
    if drop.is_empty() {
        return DuplicatePackOutput {
            streams: input.streams.clone(),
            drops: Vec::new(),
        };
    }
    let drop_set: HashSet<usize> = drop.iter().copied().collect();
    let drops = drop
        .iter()
        .map(|&i| trace_drop_of(&input.streams[i]))
        .collect();
    DuplicatePackOutput {
        streams: input
            .streams
            .iter()
            .enumerate()
            .filter(|(i, _)| !drop_set.contains(i))
            .map(|(_, s)| s.clone())
            .collect(),
        drops,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, size: f64) -> DebridFile {
        DebridFile {
            path: path.to_string(),
            size,
        }
    }

    const PACK: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SOLO: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const FILE_SIZE: f64 = 2_389_448_021.0;

    fn base_input(streams: Vec<RankingStream>, cached: &[&str]) -> DuplicatePackInput {
        DuplicatePackInput {
            streams,
            work_names: vec!["Filme Teste Sem Fronteiras".to_string()],
            work_year: Some(2016),
            cached: cached.iter().map(|s| s.to_string()).collect(),
            files: HashMap::from([(
                PACK.to_string(),
                vec![
                    file("COLECAO/12 - Filme Teste Outro - 2013.mp4", 1_658_013_619.0),
                    file(
                        "COLECAO/13 - Filme Teste Sem Fronteiras - 2016.mp4",
                        FILE_SIZE,
                    ),
                ],
            )]),
            ..Default::default()
        }
    }

    fn stream(hash: &str, name: &str, bytes: Option<f64>) -> RankingStream {
        let mut s = RankingStream {
            name: Some(name.to_string()),
            ..Default::default()
        };
        s.info_hash = Some(hash.to_string());
        s.bytes = bytes;
        s
    }

    #[test]
    fn pack_que_repete_o_arquivo_exato_sai() {
        let input = base_input(
            vec![
                stream(PACK, "pack", None),
                stream(SOLO, "solo", Some(FILE_SIZE)),
            ],
            &[PACK, SOLO],
        );
        let out = drop_duplicate_pack_files(&input);
        assert_eq!(out.streams.len(), 1);
        assert_eq!(out.streams[0].name.as_deref(), Some("solo"));
        assert_eq!(out.drops.len(), 1);
        assert_eq!(out.drops[0].reason, "duplicate-file");
    }

    #[test]
    fn um_byte_de_diferenca_nao_e_o_mesmo_arquivo() {
        let input = base_input(
            vec![
                stream(PACK, "pack", None),
                stream(SOLO, "solo", Some(FILE_SIZE + 1.0)),
            ],
            &[PACK, SOLO],
        );
        assert_eq!(drop_duplicate_pack_files(&input).streams.len(), 2);
    }

    #[test]
    fn nao_troca_play_instantaneo_por_download() {
        // Pack ⚡ e avulso sem ⚡: ficam os dois.
        let input = base_input(
            vec![
                stream(PACK, "pack", None),
                stream(SOLO, "solo", Some(FILE_SIZE)),
            ],
            &[PACK],
        );
        assert_eq!(drop_duplicate_pack_files(&input).streams.len(), 2);
        // Nenhum dos dois em cache: o avulso é tão pronto quanto o pack, sai o pack.
        let input = base_input(
            vec![
                stream(PACK, "pack", None),
                stream(SOLO, "solo", Some(FILE_SIZE)),
            ],
            &[],
        );
        assert_eq!(drop_duplicate_pack_files(&input).streams.len(), 1);
    }
}
