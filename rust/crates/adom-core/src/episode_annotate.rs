//! Porte das partes PURAS decisórias de `src/providers/episode-size.ts`
//! (`annotateEpisodeSizes` e funções irmãs): que tamanho o `💾`/`📦` do título
//! anuncia para um EPISÓDIO dentro de um pack de temporada ou um FILME dentro
//! de uma coleção, e o preenchimento de quem veio sem tamanho.
//!
//! O TS continua fazendo IO (memo `fsz`/`tsz`, `peekFileSizes`,
//! `peekTorrentTotal`, `stageTrace`) — aqui os dados já lidos chegam por
//! parâmetro: `files_by_hash` é a lista de arquivos por hash (a lista do `fsz`,
//! já filtrada para vídeo sem sample/anúncio) e `totals_by_hash` o total do
//! torrent por hash (o `tsz`). Os motivos de corte (`episodeSize.skip.*`) são
//! `stageTrace` do TS — o porte devolve os streams, quem chama traca.
//!
//! Mapeamento de volta ao TS: o stream é o `RankingStream`
//! (`stream_ranking_types`), que já tipa `title`/`name`/`infoHash`,
//! `_size`/`_indexer`/`_multiWork`. O único campo que a anotação de filme
//! escreve e o `RankingStream` não tem é `_packBytes` (interno do autofetch) —
//! viaja em `extra["_packBytes"]` e o TS grava-o de volta no stream.
//! `dropPackTextTotals`/`dropDuplicatePackFiles` e o guard do pipeline
//! (`annotateEpisodeSizes`) ficam no TS: são partes de outros módulos.
//!
//! Fidelidade de tipos: tamanhos são `f64` (o JS mede em `Number`; `js_size`
//! do seletor também devolve `f64`) e temporadas/episódios são `i64` — não
//! `u64`/`u8`, porque o `Number` do TS aceita fracionário e o parser também.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use crate::bytes_to_size::bytes_to_size;
use crate::debrid::{looks_pack_by_files, pick_file, DebridFile, PickOutcome, PlayHint, WorkHint};
use crate::episode_matching::is_season_pack_release;
use crate::episode_parse::parse_title_season_episode;
use crate::episode_size::parse_size_label;
use crate::stream_ranking_types::RankingStream;

#[path = "episode_annotate_fill.rs"]
mod episode_annotate_fill;
pub use episode_annotate_fill::*;

const PACK_MARK: &str = "📦 pack";

fn size_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new("\u{1F4BE} (\\d+(?:\\.\\d+)? (?:B|KB|MB|GB|TB))").expect("regex SIZE_MARK")
    })
}

/// `👤 ~?\d*` do TS — o trecho dos seeders onde o 💾 de quem veio sem tamanho
/// é encaixado.
pub(crate) fn seeder_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new("\u{1F464} ~?[0-9]*").expect("regex SEEDER_MARK"))
}

/// `💾 \d+… (?:B|KB)(?=\s|$)` — o BOGUS_SIZE_MARK do TS (sem espaço), usado na
/// TROCA pelo total do serviço (o espaço antes do 💾 fica).
pub(crate) fn bogus_mark_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new("\u{1F4BE} \\d+(?:\\.\\d+)? (?:B|KB)(?=\\s|$)")
            .expect("regex BOGUS_SIZE_MARK")
    })
}

/// ` ?💾 \d+… (?:B|KB)(?=\s|$)` — o 💾 de .torrent que sai quando a lista de
/// arquivos já sabe medir. Lookahead → fancy-regex.
pub(crate) fn bogus_strip_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new(" ?\u{1F4BE} \\d+(?:\\.\\d+)? (?:B|KB)(?=\\s|$)")
            .expect("regex BOGUS_SIZE_MARK")
    })
}

/// Contagem de episódios por temporada (o `meta.episodes` do Cinemeta), como
/// pares `(temporada, episódios)` — ordem livre.
pub type EpisodeCounts = [(i64, i64)];

fn count_for(meta: &EpisodeCounts, season: i64) -> i64 {
    meta.iter()
        .find(|(s, _)| *s == season)
        .map(|(_, n)| *n)
        .unwrap_or(0)
}

fn title_text(stream: &RankingStream) -> &str {
    stream.title.as_deref().unwrap_or("")
}

fn is_pack(stream: &RankingStream, season: i64) -> bool {
    stream.info_hash.is_some() && is_season_pack_release(title_text(stream), Some(season))
}

pub(crate) fn is_multi_work(stream: &RankingStream) -> bool {
    stream.info_hash.is_some() && stream.multi_work == Some(true)
}

/// Stream que chegou sem 💾: o indexer não publicou tamanho. O magnet não
/// carrega tamanho; só o debrid que já tem o hash sabe.
pub(crate) fn lacks_size(stream: &RankingStream) -> bool {
    let Some(title) = stream.title.as_deref() else {
        return false;
    };
    stream.info_hash.is_some()
        && !size_mark_re().is_match(title)
        && seeder_mark_re().is_match(title)
}

/// Arquivos do hash (a chave é minúscula, como o `keyOf` do `fsz`).
pub(crate) fn files_of<'a>(
    files_by_hash: &'a BTreeMap<String, Vec<DebridFile>>,
    info_hash: Option<&str>,
) -> Option<&'a [DebridFile]> {
    let hash = info_hash?;
    if hash.is_empty() {
        return None;
    }
    let files = files_by_hash.get(&hash.to_lowercase())?;
    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

/// Tamanho do arquivo que o play tocaria, ou `None` quando o seletor não
/// decide (pack sem o episódio, ambiguidade) — o TS mede `|| 0` no erro.
pub(crate) fn picked_size(files: &[DebridFile], hint: &PlayHint) -> Option<f64> {
    match pick_file(files, hint) {
        PickOutcome::File { size, .. } if size > 0.0 => Some(size),
        _ => None,
    }
}

/// Primeiro `💾 N unit` do título: (rótulo capturado, início, fim do casamento).
fn size_mark(title: &str) -> Option<(String, usize, usize)> {
    let caps = size_mark_re().captures(title)?;
    let whole = caps.get(0)?;
    Some((caps[1].to_string(), whole.start(), whole.end()))
}

/// Troca o primeiro `💾 N unit` por `replacement` (que recebe o rótulo
/// capturado, como o `match[1]` do TS).
fn replace_size_mark(title: &str, replacement: impl FnOnce(&str) -> String) -> Option<String> {
    let (label, start, end) = size_mark(title)?;
    Some(format!(
        "{}{}{}",
        &title[..start],
        replacement(&label),
        &title[end..]
    ))
}

/// Episódios que o pack cobre (`episodesCovered`): "S01 S04"/"S01-S04" soma as
/// temporadas do intervalo e "Complete Series" soma todas. Faltando a contagem
/// de alguma temporada coberta, não há média honesta (0).
///
/// As temporadas pedidas ficam expostas em `episodes_covered_wanted`; aqui
/// volta só o total, como no TS.
pub fn episodes_covered(title: &str, season: i64, meta: &EpisodeCounts) -> i64 {
    episodes_covered_wanted(title, season, meta)
        .iter()
        .try_fold(0i64, |total, s| {
            let n = count_for(meta, *s);
            (n != 0).then(|| total + n)
        })
        .unwrap_or(0)
}

/// Temporadas cujos episódios o pack promete (o `wanted` interno do TS).
pub fn episodes_covered_wanted(title: &str, season: i64, meta: &EpisodeCounts) -> Vec<i64> {
    let parsed = parse_title_season_episode(title);
    let mut wanted = vec![season];
    if parsed.seasons.len() > 1 {
        let low = *parsed.seasons.iter().min().expect("não vazio");
        let high = *parsed.seasons.iter().max().expect("não vazio");
        wanted = (low..=high).collect();
    } else if parsed.complete && parsed.seasons.is_empty() {
        wanted = meta.iter().map(|(s, _)| *s).collect();
    }
    wanted
}

/// Tamanho do EPISÓDIO medido pela lista de arquivos do hash, com o mesmo
/// `pick_file` do play. `None` = pack sem o episódio ou arquivos ambíguos (a
/// média ainda informa, e o play continua decidindo com as mesmas regras).
pub fn exact_episode_bytes(files: &[DebridFile], season: i64, episode: i64) -> Option<f64> {
    picked_size(
        files,
        &PlayHint {
            season: Some(season),
            episode: Some(episode),
            ..PlayHint::default()
        },
    )
}

/// Opções da anotação de pack de temporada: o pedido (S/E) e a contagem de
/// episódios do Cinemeta.
pub struct PackOpts<'a> {
    pub season: i64,
    pub episode: i64,
    pub meta: &'a EpisodeCounts,
}

/// Anota o 💾 do EPISÓDIO em pack (exato pela lista de arquivos, senão média
/// da temporada marcada "(média)"). Pack de um arquivo só, faixa parcial sem
/// medida e medida maior que o total não têm o que mostrar — stream sai igual.
pub fn annotate_pack_sizes_core(
    streams: &[RankingStream],
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &PackOpts<'_>,
) -> Vec<RankingStream> {
    streams
        .iter()
        .map(|stream| annotate_pack_one(stream, files_by_hash, opts))
        .collect()
}

fn annotate_pack_one(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &PackOpts<'_>,
) -> RankingStream {
    let Some(title) = stream.title.as_deref() else {
        return stream.clone();
    };
    if title.contains(PACK_MARK) {
        return stream.clone();
    }
    // Pack de temporada, faixa multi-episódio nomeada ("Capítulo 086 ao 123")
    // ou pack provado pela LISTA DE ARQUIVOS: o título da faixa nomeia
    // episódios e por isso não é pack para o isSeasonPackRelease, mas o torrent
    // cobre vários episódios, e o total não é o tamanho do pedido.
    let season_pack = is_pack(stream, opts.season);
    let files = files_of(files_by_hash, stream.info_hash.as_deref());
    let files_pack = !season_pack && files.is_some_and(looks_pack_by_files);
    let parsed = parse_title_season_episode(title);
    let range_pack = !season_pack
        && !files_pack
        && parsed.episodes.len() > 1
        && parsed.episodes.contains(&opts.episode);
    if !season_pack && !range_pack && !files_pack {
        return stream.clone();
    }
    // O Torrentio já responde por episódio: o 💾 dele é o tamanho do ARQUIVO
    // escolhido; dividir de novo mostraria um episódio como fração dele mesmo.
    if stream.indexer.as_deref() == Some("torrentio") {
        return stream.clone();
    }
    let Some((mark_label, _, _)) = size_mark(title) else {
        return stream.clone();
    };
    // `_size` não chega aqui (o sortAndLimit apaga): o total que o próprio
    // título anuncia é a mesma medida, arredondada em duas casas.
    let size = stream.size.unwrap_or(0.0);
    let pack_bytes = if size != 0.0 {
        size
    } else {
        parse_size_label(&mark_label)
    };
    let exact = files.and_then(|f| exact_episode_bytes(f, opts.season, opts.episode));
    // Faixa parcial ou pack provado só pela lista não tem divisor honesto para
    // média (a contagem do Cinemeta é da temporada inteira): só exato vale.
    let count = if exact.is_none() && season_pack {
        episodes_covered(title, opts.season, opts.meta)
    } else {
        0
    };
    let Some(exact_bytes) = exact else {
        if pack_bytes == 0.0 || !season_pack || count <= 1 {
            return stream.clone();
        }
        let bytes = (pack_bytes / count as f64).round();
        if pack_bytes > 0.0 && bytes >= pack_bytes {
            return stream.clone();
        }
        return with_episode_label(stream, bytes, " (média)");
    };
    if pack_bytes > 0.0 && exact_bytes >= pack_bytes {
        return stream.clone();
    }
    with_episode_label(stream, exact_bytes, "")
}

/// `💾 {rótulo} 📦 pack {total}{nota}` no lugar do 💾 original.
fn with_episode_label(stream: &RankingStream, bytes: f64, note: &str) -> RankingStream {
    let Some(title) = stream.title.as_deref() else {
        return stream.clone();
    };
    let Some(label) = bytes_to_size(bytes) else {
        return stream.clone();
    };
    let new_title = replace_size_mark(title, |total| {
        format!("\u{1F4BE} {label} {PACK_MARK} {total}{note}")
    });
    let Some(new_title) = new_title else {
        return stream.clone();
    };
    let mut out = stream.clone();
    out.title = Some(new_title);
    out
}

/// Anota o 💾 do FILME dentro de uma coleção multiobra (`annotateMovieSizes`).
/// Só a medida exata vale: filmes de uma coleção não têm tamanhos parecidos,
/// então não existe média honesta. O arquivo é o que o /resolve tocaria.
pub fn annotate_movie_sizes_core(
    streams: &[RankingStream],
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    work: &WorkHint,
) -> Vec<RankingStream> {
    if work.names.is_empty() {
        return streams.to_vec();
    }
    streams
        .iter()
        .map(|stream| annotate_movie_one(stream, files_by_hash, work))
        .collect()
}

fn annotate_movie_one(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    work: &WorkHint,
) -> RankingStream {
    annotate_movie_inner(stream, files_by_hash, work)
}

fn annotate_movie_inner(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    work: &WorkHint,
) -> RankingStream {
    let Some(title) = stream.title.as_deref() else {
        return stream.clone();
    };
    if title.contains(PACK_MARK) || is_multi_work_needs_pack_bytes(stream) || !is_multi_work(stream)
    {
        return stream.clone();
    }
    if stream.indexer.as_deref() == Some("torrentio") {
        return stream.clone();
    }
    let Some((mark_label, _, _)) = size_mark(title) else {
        return stream.clone();
    };
    let Some(files) = files_of(files_by_hash, stream.info_hash.as_deref()) else {
        return stream.clone();
    };
    let Some(bytes) = picked_size(
        files,
        &PlayHint {
            work: Some(WorkHint {
                names: work.names.clone(),
                year: work.year,
                pack: true,
            }),
            ..PlayHint::default()
        },
    ) else {
        // Coleção sem arquivo casando a obra: o play decide (e falha explícito).
        return stream.clone();
    };
    let size = stream.size.unwrap_or(0.0);
    let pack_bytes = if size != 0.0 {
        size
    } else {
        parse_size_label(&mark_label)
    };
    if pack_bytes > 0.0 && bytes >= pack_bytes {
        return stream.clone();
    }
    let Some(label) = bytes_to_size(bytes) else {
        return stream.clone();
    };
    // Filme marca só o FILME: o total segue em `_packBytes`, interno, para quem
    // precisa do tamanho do download (índice do autofetch).
    let Some(new_title) = replace_size_mark(title, |_| format!("\u{1F4BE} {label}")) else {
        return stream.clone();
    };
    let mut out = stream.clone();
    out.title = Some(new_title);
    out.extra
        .insert("_packBytes".to_string(), serde_json::json!(pack_bytes));
    out
}

/// `_packBytes` pré-existente (filme já anotado) bloqueia reanotação.
fn is_multi_work_needs_pack_bytes(stream: &RankingStream) -> bool {
    matches!(stream.extra.get("_packBytes"), Some(v) if v.as_f64().is_some_and(|n| n != 0.0))
}
