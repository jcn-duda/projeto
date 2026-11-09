//! Medida do EPISÓDIO dentro de um pack — a mesma que o `💾` anuncia
//! ([`super::annotate_pack_sizes_core`]) e que o limite de tamanho do usuário
//! (`maxSizeGb`) passa a julgar em busca de episódio.
//!
//! Antes o limite olhava o total do torrent: um pack de temporada dublado de
//! 45 GB com episódios de 3 GB sumia com `maxSizeGb=40`, e série BR quase só
//! sai em pack — o limite mediano escondia justo o dublado.

use std::collections::BTreeMap;

use crate::debrid::{looks_pack_by_files, DebridFile};
use crate::episode_parse::parse_title_season_episode;
use crate::episode_size::parse_size_label;
use crate::stream_ranking_types::RankingStream;

use super::{episodes_covered, exact_episode_bytes, files_of, is_pack, size_mark, PackOpts};

/// O que se sabe do episódio pedido dentro do stream.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PackEpisodeSize {
    /// Não é pack (ou o tamanho já é do arquivo, caso do Torrentio): o total
    /// do stream É o tamanho do episódio.
    NotPack,
    /// Pack sem medida honesta do episódio (sem lista nem contagem).
    Unknown,
    /// Arquivo do episódio na lista do debrid; `pack` é o total conhecido (0
    /// quando o título não anuncia).
    Exact { bytes: f64, pack: f64 },
    /// Total do pack dividido pelos episódios que ele cobre.
    Average(f64),
}

/// Mede o episódio `opts.episode` dentro do stream.
pub fn pack_episode_size(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &PackOpts<'_>,
) -> PackEpisodeSize {
    let Some(title) = stream.title.as_deref() else {
        return PackEpisodeSize::NotPack;
    };
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
        return PackEpisodeSize::NotPack;
    }
    // O Torrentio já responde por episódio: o 💾 dele é o tamanho do ARQUIVO
    // escolhido; dividir de novo mostraria um episódio como fração dele mesmo.
    if stream.indexer.as_deref() == Some("torrentio") {
        return PackEpisodeSize::NotPack;
    }
    // `_size` não chega à anotação (o sortAndLimit apaga): o total que o
    // próprio título anuncia é a mesma medida, arredondada em duas casas.
    let size = stream.size.unwrap_or(0.0);
    let pack_bytes = if size != 0.0 {
        size
    } else {
        size_mark(title).map_or(0.0, |(label, _, _)| parse_size_label(&label))
    };
    if let Some(bytes) = files.and_then(|f| exact_episode_bytes(f, opts.season, opts.episode)) {
        return PackEpisodeSize::Exact {
            bytes,
            pack: pack_bytes,
        };
    }
    // Faixa parcial ou pack provado só pela lista não tem divisor honesto para
    // média (a contagem do Cinemeta é da temporada inteira): só exato vale.
    let count = if season_pack {
        episodes_covered(title, opts.season, opts.meta)
    } else {
        0
    };
    if pack_bytes == 0.0 || !season_pack || count <= 1 {
        return PackEpisodeSize::Unknown;
    }
    let bytes = (pack_bytes / count as f64).round();
    if pack_bytes > 0.0 && bytes >= pack_bytes {
        return PackEpisodeSize::Unknown;
    }
    PackEpisodeSize::Average(bytes)
}

/// O stream cabe no `maxSizeGb` (em bytes; `<= 0` desliga) numa busca de
/// episódio? Não-pack julga o total (o `fits_size` do ranking); pack julga o
/// EPISÓDIO, e pack sem medida passa — a mesma regra do stream sem tamanho.
pub fn fits_episode_size_limit(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &PackOpts<'_>,
    max_bytes: f64,
) -> bool {
    if max_bytes <= 0.0 {
        return true;
    }
    if stream
        .size
        .filter(|n| n.is_finite())
        .is_none_or(|n| n <= max_bytes)
    {
        return true;
    }
    match pack_episode_size(stream, files_by_hash, opts) {
        PackEpisodeSize::NotPack => false,
        PackEpisodeSize::Unknown => true,
        PackEpisodeSize::Exact { bytes, .. } | PackEpisodeSize::Average(bytes) => {
            bytes <= max_bytes
        }
    }
}
