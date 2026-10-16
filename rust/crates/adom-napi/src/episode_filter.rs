//! Ponte NAPI do filtro de episódio em lote: `filterSeriesEpisodeRaw`
//! (`src/providers/stream-builder-episode-filter.ts`) decide INTEIROS no
//! núcleo, numa chamada por lote. O corte `preAirReleases` (banco de magnets)
//! e o enriquecimento `bankByHash` ficam do lado Node — aqui chegam só os
//! hashes já excluídos. Saem só índices + código do motivo (padrão do
//! `relevance.rs`); o rótulo string fica no Node.

use adom_core::{filter_series_episode, EpisodeFilterItem as CoreItem, SeriesEpisodeRejectReason};
use napi_derive::napi;

/// Campos de `RawItem` que o laço lê. `undefined`/vazio = ausente (o `||` do
/// JS). `magnet` chega JÁ ENRIQUECIDO pelo banco.
#[napi(object)]
pub struct EpisodeFilterEntry {
    pub title: Option<String>,
    pub title_pascal: Option<String>,
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
    pub info_hash: Option<String>,
    pub from_account: bool,
    pub is_br: bool,
}

/// Rejeitado: índice do item e código do motivo (`SeriesEpisodeRejectReason`).
#[napi(object)]
pub struct SeriesEpisodeRejectedNapi {
    pub index: u32,
    /// Código do motivo = posição em `EPISODE_FILTER_LABELS` do TS.
    pub reason: u32,
}

/// Resultado: índices mantidos e, em ordem de disparo, os rejeitados.
#[napi(object)]
pub struct SeriesEpisodeOutcomeNapi {
    pub kept: Vec<u32>,
    pub rejected: Vec<SeriesEpisodeRejectedNapi>,
}

/// `filterSeriesEpisodeRaw` sem o pre-air e sem o banco: laço em lote.
///
/// `universe` é `seriesUniverse`; `names` são os aliases da obra;
/// `pre_air_hashes` já vêm minúsculos; `title_precision_tail_cut` espelha
/// `config.search.titlePrecisionTailCut` (default `true`).
#[napi(catch_unwind)]
#[allow(clippy::too_many_arguments)]
pub fn filter_series_episode_napi(
    items: Vec<EpisodeFilterEntry>,
    season: i64,
    episode: i64,
    universe: Vec<String>,
    names: Vec<String>,
    unaired: bool,
    pre_air_hashes: Vec<String>,
    title_precision_tail_cut: Option<bool>,
) -> SeriesEpisodeOutcomeNapi {
    // Bloco interno: os empréstimos morrem antes de montar o retorno (os
    // objetos napi têm Drop, e o borrowck confunde a ordem no mesmo escopo).
    let (kept, rejected) = {
        let core_items: Vec<CoreItem> = items
            .iter()
            .map(|e| CoreItem {
                title: e.title.as_deref(),
                title_pascal: e.title_pascal.as_deref(),
                magnet: e.magnet.as_deref(),
                magnet_uri: e.magnet_uri.as_deref(),
                guid: e.guid.as_deref(),
                info_hash: e.info_hash.as_deref(),
                from_account: e.from_account,
                is_br: e.is_br,
            })
            .collect();
        let out = filter_series_episode(
            &core_items,
            season,
            episode,
            &universe,
            &names,
            unaired,
            &pre_air_hashes,
            title_precision_tail_cut.unwrap_or(true),
        );
        (
            out.kept,
            out.rejected
                .into_iter()
                .map(|(index, reason)| {
                    (
                        index,
                        match reason {
                            SeriesEpisodeRejectReason::PreAir => 0,
                            SeriesEpisodeRejectReason::Episode => 1,
                            SeriesEpisodeRejectReason::SeriesWork => 2,
                            SeriesEpisodeRejectReason::Unaired => 3,
                            SeriesEpisodeRejectReason::Article => 4,
                        },
                    )
                })
                .collect::<Vec<(u32, u32)>>(),
        )
    };
    SeriesEpisodeOutcomeNapi {
        kept,
        rejected: rejected
            .into_iter()
            .map(|(index, reason)| SeriesEpisodeRejectedNapi { index, reason })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str) -> EpisodeFilterEntry {
        EpisodeFilterEntry {
            title: Some(title.to_string()),
            title_pascal: None,
            magnet: None,
            magnet_uri: None,
            guid: None,
            info_hash: None,
            from_account: false,
            is_br: false,
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn call(items: Vec<EpisodeFilterEntry>, unaired: bool) -> SeriesEpisodeOutcomeNapi {
        filter_series_episode_napi(
            items,
            1,
            2,
            names(&["Serie"]),
            names(&["Serie"]),
            unaired,
            vec![],
            Some(true),
        )
    }

    #[test]
    fn episódio_errado_rejeita_com_código_1() {
        let out = call(
            vec![entry("Serie S01E03 1080p"), entry("Serie S01E02 1080p")],
            false,
        );
        assert_eq!(out.kept, vec![1]);
        assert_eq!(out.rejected.len(), 1);
        assert_eq!(out.rejected[0].index, 0);
        assert_eq!(out.rejected[0].reason, 1); // 'episode'
    }

    #[test]
    fn pre_air_rejeita_com_código_0() {
        let mut a = entry("Serie S01E02 1080p");
        a.info_hash = Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string());
        let out = filter_series_episode_napi(
            vec![a],
            1,
            2,
            names(&["Serie"]),
            names(&["Serie"]),
            false,
            vec!["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string()],
            Some(true),
        );
        assert!(out.kept.is_empty());
        assert_eq!(out.rejected[0].reason, 0); // 'pre-air'
    }

    #[test]
    fn dn_contraditório_rejeita_com_código_1() {
        let mut a = entry("Serie S01E02 1080p");
        a.magnet = Some(
            "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Serie+S01E05"
                .to_string(),
        );
        let out = call(vec![a], false);
        assert!(out.kept.is_empty());
        assert_eq!(out.rejected[0].reason, 1); // 'episode' via dn
    }

    #[test]
    fn unaired_sem_nome_rejeita_com_código_3() {
        let out = call(vec![entry("Serie S01 2160p")], true);
        assert!(out.kept.is_empty());
        assert_eq!(out.rejected[0].reason, 3); // 'unaired'
    }

    #[test]
    fn artigo_estrangeiro_na_conta_rejeita_com_código_4() {
        let mut a = entry("A Origem 4k 2160p Dual Audio");
        a.from_account = true;
        let out = filter_series_episode_napi(
            vec![a],
            1,
            2,
            names(&["From"]),
            names(&["From"]),
            false,
            vec![],
            Some(true),
        );
        assert!(out.kept.is_empty());
        assert_eq!(out.rejected[0].reason, 4); // 'article'
    }

    #[test]
    fn global_sem_marcador_outra_obra_rejeita_com_código_2() {
        let out = filter_series_episode_napi(
            vec![entry("Filme Qualquer 2020 1080p")],
            1,
            2,
            names(&["Serie"]),
            names(&["Serie"]),
            false,
            vec![],
            Some(true),
        );
        assert_eq!(out.rejected[0].reason, 2); // 'series-work'
    }

    #[test]
    fn pack_da_temporada_passa() {
        let out = call(vec![entry("Serie Temporada 1 Completa")], false);
        assert_eq!(out.kept, vec![0]);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn br_com_artigo_do_nome_pt_passa() {
        let mut a = entry("O Urso S01E02 Dual Audio");
        a.is_br = true;
        let out = filter_series_episode_napi(
            vec![a],
            1,
            2,
            names(&["O Urso", "The Bear"]),
            names(&["O Urso", "The Bear"]),
            false,
            vec![],
            Some(true),
        );
        assert_eq!(out.kept, vec![0]);
    }
}
