use std::collections::BTreeMap;

use fancy_regex::Regex as FancyRegex;

use crate::bytes_to_size::bytes_to_size;
use crate::debrid::{DebridFile, PlayHint, WorkHint};
use crate::stream_ranking_types::RankingStream;

use super::{
    bogus_mark_re, bogus_strip_re, files_of, is_multi_work, lacks_size, picked_size, seeder_mark_re,
};

/// Opções do preenchimento: pedido (S/E) e a dica de obra marcada como pack.
pub struct FillOpts<'a> {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub work: Option<&'a WorkHint>,
}

/// Preenche o 💾 de quem veio sem tamanho, com o arquivo que o play tocaria
/// (mesmo `pickFile`). Só medida exata: sem lista de arquivos, segue sem 💾.
pub fn fill_missing_sizes_core(
    streams: &[RankingStream],
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &FillOpts<'_>,
) -> Vec<RankingStream> {
    streams
        .iter()
        .map(|stream| fill_missing_one(stream, files_by_hash, opts))
        .collect()
}

fn fill_missing_one(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    opts: &FillOpts<'_>,
) -> RankingStream {
    if !lacks_size(stream) {
        return stream.clone();
    }
    let multi_work = opts.season.is_none() && is_multi_work(stream);
    let work = opts.work.filter(|_| multi_work);
    // Coleção sem a obra marcada: o maior arquivo não é o filme pedido.
    if multi_work && work.is_none_or(|w| w.names.is_empty()) {
        return stream.clone();
    }
    let Some(files) = files_of(files_by_hash, stream.info_hash.as_deref()) else {
        return stream.clone();
    };
    let hint = if let Some(season) = opts.season {
        PlayHint {
            season: Some(season),
            episode: opts.episode,
            ..PlayHint::default()
        }
    } else if let Some(w) = work {
        PlayHint {
            work: Some(WorkHint {
                names: w.names.clone(),
                year: w.year,
                pack: true,
            }),
            ..PlayHint::default()
        }
    } else {
        PlayHint::default()
    };
    let Some(bytes) = picked_size(files, &hint) else {
        return stream.clone();
    };
    let Some(label) = bytes_to_size(bytes) else {
        return stream.clone();
    };
    let Some(title) = stream.title.as_deref() else {
        return stream.clone();
    };
    let caps = match seeder_mark_re().captures(title) {
        Some(caps) => caps,
        None => return stream.clone(),
    };
    let whole = match caps.get(0) {
        Some(m) => m,
        None => return stream.clone(),
    };
    let mut out = stream.clone();
    out.title = Some(format!(
        "{} \u{1F4BE} {}{}",
        &title[..whole.end()],
        label,
        &title[whole.end()..]
    ));
    out
}

/// 💾 do TOTAL do torrent (`tsz`) para quem o tracker deixou sem tamanho ou com
/// o do .torrent (KB). Com lista de arquivos do hash (`fsz`) o total NÃO entra:
/// o `fillMissingSizes` do fim mede o episódio exato, e o total antes dele o
/// bloqueava — o 💾 em KB sai junto, para o exato poder preencher.
pub fn fill_torrent_totals_core(
    streams: &[RankingStream],
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    totals_by_hash: &BTreeMap<String, f64>,
) -> Vec<RankingStream> {
    streams
        .iter()
        .map(|stream| fill_totals_one(stream, files_by_hash, totals_by_hash))
        .collect()
}

fn fill_totals_one(
    stream: &RankingStream,
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    totals_by_hash: &BTreeMap<String, f64>,
) -> RankingStream {
    let Some(title) = stream.title.as_deref() else {
        return stream.clone();
    };
    if stream.info_hash.is_none() {
        return stream.clone();
    }
    let bogus = bogus_strip_re().is_match(title).unwrap_or(false);
    if !bogus && !lacks_size(stream) {
        return stream.clone();
    }
    if files_of(files_by_hash, stream.info_hash.as_deref()).is_some() {
        if !bogus {
            return stream.clone();
        }
        let mut out = stream.clone();
        if let Some(stripped) = fancy_replace_first(bogus_strip_re(), title, "") {
            out.title = Some(stripped);
        }
        return out;
    }
    let total = totals_by_hash
        .get(
            stream
                .info_hash
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .as_str(),
        )
        .copied()
        .unwrap_or(0.0);
    let Some(label) = bytes_to_size(total) else {
        return stream.clone();
    };
    let mut out = stream.clone();
    if bogus {
        out.title = fancy_replace_first(bogus_mark_re(), title, &format!("\u{1F4BE} {label}"));
    } else {
        let caps = match seeder_mark_re().captures(title) {
            Some(caps) => caps.get(0),
            None => None,
        };
        let Some(whole) = caps else {
            return stream.clone();
        };
        out.title = Some(format!(
            "{} \u{1F4BE} {}{}",
            &title[..whole.end()],
            label,
            &title[whole.end()..]
        ));
    }
    out
}

/// Primeira ocorrência substituída, com o mesmo comportamento do
/// `String.replace` do JS (o `fancy-regex` não tem `replace` com lookahead).
fn fancy_replace_first(re: &FancyRegex, text: &str, replacement: &str) -> Option<String> {
    let caps = re.captures(text).ok().flatten()?;
    let whole = caps.get(0)?;
    Some(format!(
        "{}{replacement}{}",
        &text[..whole.start()],
        &text[whole.end()..]
    ))
}
