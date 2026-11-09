//! Limite de tamanho do usuário (`maxSizeGb`) em busca de episódio.
//!
//! O `sort_and_limit` julga o total do torrent, e em série isso cortava o pack
//! de temporada inteiro pelo tamanho da temporada — série BR quase só sai em
//! pack, e um limite mediano escondia justo o dublado. Aqui o corte de série é
//! feito ANTES do ranking com a medida do episódio
//! ([`adom_core::fits_episode_size_limit`]: exato pela lista de arquivos, senão
//! a média; pack sem medida passa) e o ranking recebe o limite desligado.
//! Filme segue com o corte do ranking, intocado.

use std::collections::BTreeMap;

use adom_core::{fits_episode_size_limit, DebridFile, PackOpts, RankingStream};

use super::types::{BuildContext, BuildOptions, BuiltList};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// Corta o que não cabe no limite e devolve o `max_size_gb` que o ranking
/// ainda deve aplicar (0 quando o corte de série já foi feito aqui).
pub(super) fn episode_size_limit(
    streams: &mut Vec<RankingStream>,
    ctx: &BuildContext,
    opts: &BuildOptions,
    files: &BTreeMap<String, Vec<DebridFile>>,
    out: &mut BuiltList,
) -> f64 {
    let (Some(season), Some(episode)) = (ctx.season, ctx.episode) else {
        return opts.max_size_gb;
    };
    if opts.max_size_gb <= 0.0 {
        return opts.max_size_gb;
    }
    let pack = PackOpts {
        season,
        episode,
        meta: &ctx.episode_counts,
    };
    let max_bytes = opts.max_size_gb * GIB;
    let before = streams.len();
    streams.retain(|stream| fits_episode_size_limit(stream, files, &pack, max_bytes));
    if streams.len() < before {
        out.count("size-limit", before - streams.len());
    }
    0.0
}

#[cfg(test)]
#[path = "size_limit_tests.rs"]
mod tests;
