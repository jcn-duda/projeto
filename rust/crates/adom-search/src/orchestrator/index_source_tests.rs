use super::*;
use serde_json::json;

fn allowed(indexer: &str, options: &serde_json::Value) -> bool {
    allowed_source_indexer(indexer, options, &["redetorrent".to_string()], &[])
}

#[test]
fn modo_off_e_o_default_e_parse_nao_liga_por_acidente() {
    assert_eq!(IndexMode::default(), IndexMode::Off);
    assert_eq!(IndexMode::parse(""), IndexMode::Off);
    assert_eq!(IndexMode::parse("talvez"), IndexMode::Off);
    assert_eq!(IndexMode::parse("on"), IndexMode::On);
    assert_eq!(IndexMode::parse("1"), IndexMode::On);
    assert_eq!(IndexMode::parse("true"), IndexMode::On);
    assert_eq!(IndexMode::parse("SHADOW"), IndexMode::Off);
    assert!(!IndexMode::Off.uses_native());
    assert!(IndexMode::On.uses_native());
    assert!(IndexMode::On.is_on());
}

#[test]
fn origens_nao_indexer_passam_sempre() {
    let options = json!({"providers": ["jackett"]});
    assert!(allowed("", &options));
    assert!(allowed("autofetch", &options));
    assert!(allowed("bludv", &options));
    assert!(allowed("account", &options));
}

#[test]
fn torrentio_respeita_a_selecao_de_providers() {
    assert!(!allowed("torrentio", &json!({"providers": ["jackett"]})));
    assert!(allowed("torrentio", &json!({"providers": ["torrentio"]})));
    assert!(allowed("torrentio", &json!({"providers": ["both"]})));
    // Sem `providers` no overlay, o default do operador não inventa torrentio.
    assert!(!allowed("torrentio", &json!({})));
}

#[test]
fn index_only_nunca_e_cortado_pelo_ji() {
    let options = json!({"providers": ["jackett"], "jackettIndexers": ["bludv"]});
    assert!(allowed("redetorrent", &options));
}

#[test]
fn ji_da_url_vence_o_default_do_operador() {
    let options =
        json!({"providers": ["jackett"], "jackettIndexers": ["nerdfilmes", "comandotorrents"]});
    assert!(allowed("nerdfilmes", &options));
    assert!(
        allowed("bludv", &options),
        "bludv é fonte nativa, não Jackett"
    );
    assert!(!allowed("outro", &options));
    // Default do operador quando a URL não trouxe `ji`.
    let sem_ji = json!({"providers": ["jackett"]});
    assert!(allowed_source_indexer(
        "comandotorrents",
        &sem_ji,
        &[],
        &["comandotorrents".to_string()]
    ));
    assert!(!allowed_source_indexer(
        "nerdfilmes",
        &sem_ji,
        &[],
        &["comandotorrents".to_string()]
    ));
}

#[test]
fn obra_targets_do_node() {
    let filme = obra_targets("movie", None, None);
    assert_eq!(filme.len(), 1);
    let serie = obra_targets("series", Some(2), Some(5));
    assert_eq!(
        serie,
        vec![
            WorkTarget {
                season: Some(2),
                episode: Some(5)
            },
            WorkTarget {
                season: Some(2),
                episode: None
            },
            WorkTarget {
                season: None,
                episode: None
            }
        ]
    );
    let temporada = obra_targets("series", Some(2), None);
    assert_eq!(temporada.len(), 2, "sem episódio não há o alvo do episódio");
}

#[test]
fn tetos_e_janela_de_leitura_clampados() {
    assert_eq!(bank_limits(0, 0), (40, 40));
    assert_eq!(bank_limits(100, 900), (40, 500));
    assert_eq!(bank_limits(5, 10), (5, 10));
    assert_eq!(bank_read_window(40, 40), (80, 120));
    assert_eq!(bank_read_window(5, 500), (200, 1500));
}
