//! Corte pré-lançamento doméstico em item que veio do índice, sem magnet.
//!
//! Caso medido em produção (`tt33764258`, A Odisseia do Nolan, doméstico em
//! 17/11/2026): a NerdFilmes publica magnets WEBRip/WEB-DL de outra obra sob o
//! título "A Odisseia [1080p LEGENDADO 1.83 GB]". O `idx:v14` guarda esse título
//! e o `mediaSource`, mas não o `dn`, então título e `dn` não declaravam fonte
//! doméstica e o filme errado entrava na lista.

use adom_core::{filter_relevant_raw, RelevanceItem, RelevanceQuery, RelevanceSettings};

const NOW: i64 = 1_793_000_000_000;
const HOME_RELEASE_AT: i64 = 1_794_873_600_000;

fn indexed(media_source: Option<&str>) -> RelevanceItem {
    RelevanceItem {
        title: Some("A Odisseia (2026) [1080p LEGENDADO 1.83 GB]".to_string()),
        is_br: true,
        media_source: media_source.map(str::to_string),
        ..Default::default()
    }
}

fn keeps(item: RelevanceItem, now_ms: i64, cut: bool) -> bool {
    let names = vec!["The Odyssey".to_string(), "A Odisseia".to_string()];
    let query = RelevanceQuery {
        names: &names,
        year: "2026",
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: Some(HOME_RELEASE_AT),
    };
    let settings = RelevanceSettings {
        now_ms,
        pre_home_release_cut: cut,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut: true,
    };
    filter_relevant_raw(&[item], &query, &settings).kept == [0]
}

#[test]
fn fonte_domestica_do_indice_cai_antes_do_lancamento() {
    assert!(!keeps(indexed(Some("WEBRip")), NOW, true));
    assert!(!keeps(indexed(Some("WEB-DL")), NOW, true));
}

#[test]
fn gravacao_de_cinema_e_item_sem_fonte_continuam() {
    assert!(keeps(indexed(Some("CAM")), NOW, true));
    assert!(keeps(indexed(None), NOW, true));
}

#[test]
fn fonte_domestica_passa_depois_do_lancamento_ou_sem_o_corte() {
    assert!(keeps(indexed(Some("WEBRip")), HOME_RELEASE_AT + 1, true));
    assert!(keeps(indexed(Some("WEBRip")), NOW, false));
}
