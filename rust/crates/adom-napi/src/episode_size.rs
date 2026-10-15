//! Lote da anotação de tamanho de episódio/filme (`annotateEpisodeSizes` do
//! `src/providers/episode-size.ts`): UMA chamada napi compõe as partes puras já
//! portadas no core (fill de totais `tsz`, anotação de pack/filme pela lista
//! `fsz`, guarda de pack, corte do total em texto, fill de quem veio sem 💾 e
//! dedupe de pack repetido) e devolve a lista anotada inteira.
//!
//! O IO continua no Node: `files_by_hash` é a caixa do `peekFileSizes` (chave
//! minúscula, lista já filtrada para vídeo) e `totals_by_hash` a do
//! `peekTorrentTotal` — quem chama lê os caches `fsz`/`tsz` e manda de uma vez.
//! Os motivos de corte (`episodeSize.skip.*`) são `stageTrace` do TS: o porte
//! devolve os streams, quem chama traca.
//!
//! # Contrato de fronteira
//!
//! Mesmo do `ranking.rs`: streams cruzam como `serde_json::Value` (o
//! `RankingStream` preserva campos desconhecidos) e arquivos como pares
//! `path`/`size` (só o que o seletor lê cruza a fronteira).

use std::collections::{BTreeMap, HashMap, HashSet};

use adom_core::{
    annotate_movie_sizes_core, annotate_pack_sizes_core, drop_duplicate_pack_files,
    drop_pack_text_totals, fill_missing_sizes_core, fill_torrent_totals_core,
    is_season_pack_release, parse_title_season_episode, DebridFile, DuplicatePackInput,
    DuplicatePackOutput, FillOpts, PackOpts, PackTextTotalsInput, RankingStream, WorkHint,
};
use napi_derive::napi;
use serde_json::Value;

/// Arquivo dentro de um torrent, como o `fsz` o reporta. Só `path` e `size`
/// atravessam: `link`/`id` ficam no Node.
#[napi(object)]
pub struct NapiDebridFile {
    pub path: String,
    pub size: f64,
}

/// Contagem de episódios por temporada (o `meta.episodes` do Cinemeta).
#[napi(object)]
pub struct SeasonCount {
    pub season: f64,
    pub episodes: f64,
}

/// Entrada da anotação, no formato do TS (`AnnotateOptions` + caches lidos).
#[napi(object)]
pub struct AnnotateInput {
    /// Streams pós-sortAndLimit; `null` no array é descartado.
    pub streams: Vec<Value>,
    /// `fsz`: lista de arquivos por hash (chave minúscula).
    pub files_by_hash: HashMap<String, Vec<NapiDebridFile>>,
    /// `tsz`: total do torrent por hash (chave minúscula).
    pub totals_by_hash: HashMap<String, f64>,
    /// `null` = filme (coleção multiobra).
    pub season: Option<f64>,
    /// `null` = série sem episódio (não anota nada).
    pub episode: Option<f64>,
    /// `meta.episodes` do Cinemeta, achatado.
    pub episodes_meta: Vec<SeasonCount>,
    /// Dica de obra `w` (`work.n` do TS).
    pub work_names: Vec<String>,
    /// `work.y` do TS.
    pub work_year: Option<f64>,
    /// Hashes provados ⚡; `None` = checagem desconhecida, sem dedupe de pack.
    pub cached_hashes: Option<Vec<String>>,
}

/// Saída: streams anotados, na mesma ordem da entrada.
#[napi(object)]
pub struct AnnotateOutput {
    pub streams: Vec<Value>,
}

fn opt_i64(v: Option<f64>) -> Option<i64> {
    v.filter(|n| n.is_finite()).map(|n| n as i64)
}

fn parse_streams(values: &[Value]) -> Vec<RankingStream> {
    values
        .iter()
        .filter_map(|v| serde_json::from_value::<RankingStream>(v.clone()).ok())
        .collect()
}

fn files_of(
    files_by_hash: &HashMap<String, Vec<NapiDebridFile>>,
) -> BTreeMap<String, Vec<DebridFile>> {
    files_by_hash
        .iter()
        .map(|(hash, files)| {
            (
                hash.to_lowercase(),
                files
                    .iter()
                    .map(|f| DebridFile {
                        path: f.path.clone(),
                        size: f.size,
                    })
                    .collect(),
            )
        })
        .collect()
}

/// `Boolean(stream.infoHash) && stream._multiWork` — o `isMultiWorkPack` TS.
fn is_multi_work(stream: &RankingStream) -> bool {
    stream.info_hash.as_deref().is_some_and(|h| !h.is_empty()) && stream.multi_work == Some(true)
}

/// `Boolean(stream.infoHash) && isSeasonPackRelease(stream, season)`.
fn is_pack(stream: &RankingStream, season: i64) -> bool {
    stream.info_hash.as_deref().is_some_and(|h| !h.is_empty())
        && is_season_pack_release(stream.title.as_deref().unwrap_or(""), Some(season))
}

/// Compõe a travessia inteira da anotação. Função pura: sem IO e sem trace.
pub(crate) fn annotate(input: &AnnotateInput) -> Vec<RankingStream> {
    let season = opt_i64(input.season);
    let episode = opt_i64(input.episode);
    let work = WorkHint {
        names: input.work_names.clone(),
        year: opt_i64(input.work_year),
        pack: true,
    };
    let meta: Vec<(i64, i64)> = input
        .episodes_meta
        .iter()
        .filter_map(|s| Some((opt_i64(Some(s.season))?, opt_i64(Some(s.episodes))?)))
        .collect();
    let files = files_of(&input.files_by_hash);
    let totals: BTreeMap<String, f64> = input
        .totals_by_hash
        .iter()
        .map(|(h, t)| (h.to_lowercase(), *t))
        .collect();
    let original = parse_streams(&input.streams);

    // 1) 💾 do total do torrent (`tsz`) para quem veio sem tamanho ou em KB.
    let filled = fill_torrent_totals_core(&original, &files, &totals);
    // 2) Anotação do episódio (pack da temporada) ou do filme (coleção); série
    //    sem episódio não tem arquivo único para medir.
    let annotated = match (season, episode) {
        (None, _) => annotate_movie_sizes_core(&filled, &files, &work),
        (Some(_), None) => filled.clone(),
        (Some(season), Some(episode)) => annotate_pack_sizes_core(
            &filled,
            &files,
            &PackOpts {
                season,
                episode,
                meta: &meta,
            },
        ),
    };
    // 3) Guarda do pipeline: pack que ganhou o TOTAL do `tsz` e a anotação não
    //    reduziu ao episódio/filme volta a ficar sem 💾 (o original vence).
    let names_episode = |s: &RankingStream, ep: i64| {
        parse_title_season_episode(s.title.as_deref().unwrap_or(""))
            .episodes
            .contains(&ep)
    };
    let guarded: Vec<RankingStream> = annotated
        .into_iter()
        .enumerate()
        .map(|(idx, stream)| {
            let filled_stream = &filled[idx];
            let some_original = original.get(idx);
            let unchanged_by_fill = some_original.is_some_and(|o| *o == *filled_stream);
            if *filled_stream == stream || unchanged_by_fill {
                return stream;
            }
            let Some(orig) = some_original else {
                return stream;
            };
            let pack = match season {
                Some(season) => {
                    is_pack(orig, season) || episode.is_some_and(|ep| !names_episode(orig, ep))
                }
                None => is_multi_work(orig),
            };
            if pack {
                orig.clone()
            } else {
                stream
            }
        })
        .collect();
    // Série sem episódio não tem arquivo único para medir: para aqui.
    if season.is_some() && episode.is_none() {
        return guarded;
    }
    // 4) Total do pack sai do TEXTO quando a anotação não o reduziu.
    //    (As funções de corte pedem `HashMap`; a anotação, `BTreeMap`.)
    let files_hm: HashMap<String, Vec<DebridFile>> =
        files.iter().map(|(h, f)| (h.clone(), f.clone())).collect();
    let dropped = drop_pack_text_totals(&PackTextTotalsInput {
        streams: guarded,
        season,
        episode,
        files: files_hm.clone(),
    });
    // 5) Fill do 💾 de quem veio sem tamanho, pelo arquivo que o play tocaria.
    let sized = fill_missing_sizes_core(
        &dropped.streams,
        &files,
        &FillOpts {
            season,
            episode,
            work: Some(&work),
        },
    );
    // 6) Com a checagem conhecida, o pack que repete o arquivo de um avulso sai.
    match &input.cached_hashes {
        Some(hashes) => {
            let DuplicatePackOutput { streams, .. } =
                drop_duplicate_pack_files(&DuplicatePackInput {
                    streams: sized,
                    season,
                    episode,
                    work_names: input.work_names.clone(),
                    work_year: opt_i64(input.work_year),
                    cached: hashes.iter().cloned().collect::<HashSet<String>>(),
                    files: files_hm,
                });
            streams
        }
        None => sized,
    }
}

/// Anotação completa numa travessia (ver doc do módulo).
#[napi(catch_unwind)]
pub fn annotate_episode_sizes(input: AnnotateInput) -> AnnotateOutput {
    let streams = annotate(&input)
        .into_iter()
        .map(|s| serde_json::to_value(&s).unwrap_or(Value::Null))
        .collect();
    AnnotateOutput { streams }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HASH: &str = "aabbccddeeff00112233445566778899aabbccdd";

    fn input(streams: Vec<Value>) -> AnnotateInput {
        AnnotateInput {
            streams,
            files_by_hash: HashMap::new(),
            totals_by_hash: HashMap::new(),
            season: None,
            episode: None,
            episodes_meta: Vec::new(),
            work_names: Vec::new(),
            work_year: None,
            cached_hashes: None,
        }
    }

    #[test]
    fn lista_vazia_devolve_vazia() {
        assert!(annotate(&input(Vec::new())).is_empty());
    }

    #[test]
    fn total_do_torrent_preenche_sem_tamanho() {
        let mut inp = input(vec![json!({
            "infoHash": HASH, "title": "Show S01 1080p DUBLADO \u{1F464} ~5",
        })]);
        inp.totals_by_hash
            .insert(HASH.to_string(), 12_880_000_000.0);
        let out = annotate(&inp);
        let title = out[0].title.as_deref().unwrap_or_default();
        assert!(title.contains("💾"), "esperava 💾 no título: {title}");
    }

    #[test]
    fn pack_da_temporada_ganha_media_do_episodio() {
        let mut inp = input(vec![json!({
            "infoHash": HASH, "title": "Show S01 Temporada Completa 1080p 💾 4.00 GB",
            "_indexer": "bludv",
        })]);
        inp.season = Some(1.0);
        inp.episode = Some(3.0);
        inp.episodes_meta = vec![SeasonCount {
            season: 1.0,
            episodes: 8.0,
        }];
        let out = annotate(&inp);
        let title = out[0].title.as_deref().unwrap_or_default();
        assert!(
            title.contains("📦 pack"),
            "esperava anotação de pack: {title}"
        );
        assert!(title.contains("(média)"), "esperava média: {title}");
    }

    #[test]
    fn pack_sem_reducao_perde_o_total_do_texto() {
        let original = json!({
            "infoHash": HASH, "title": "Show Temporada Completa 💾 40.00 GB",
        });
        let mut inp = input(vec![original.clone()]);
        inp.season = Some(1.0);
        inp.episode = Some(3.0);
        // Total do tsz entra, mas a anotação não tem contagem nem exato: o pack
        // não reduz ao episódio e o total sai do TEXTO (vira `_packBytes`).
        inp.totals_by_hash
            .insert(HASH.to_string(), 40_000_000_000.0);
        let out = annotate(&inp);
        let v = serde_json::to_value(&out[0]).unwrap();
        assert_eq!(v["title"], json!("Show Temporada Completa"));
        assert_eq!(v["_packBytes"], serde_json::json!(42_949_672_960.0));
    }

    #[test]
    fn filme_em_colecao_nao_tem_media() {
        let mut inp = input(vec![json!({
            "infoHash": HASH, "title": "COLEÇÃO COMPLETA 💾 22.45 GB",
            "_multiWork": true,
        })]);
        inp.work_names = vec!["Star Trek".to_string()];
        inp.work_year = Some(2009.0);
        inp.files_by_hash.insert(
            HASH.to_string(),
            vec![
                NapiDebridFile {
                    path: "Star.Trek.2009.mkv".to_string(),
                    size: 2_100_000_000.0,
                },
                NapiDebridFile {
                    path: "Outro.Filme.mkv".to_string(),
                    size: 20_000_000_000.0,
                },
            ],
        );
        let out = annotate(&inp);
        let title = out[0].title.as_deref().unwrap_or_default();
        // `js_size` mede em GiB: 2_100_000_000 bytes = "1.96 GB".
        assert!(title.contains("💾 1.96 GB"), "{title}");
    }
}
