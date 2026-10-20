//! Testes do parser do Mico, comparados com as regex do `src/providers/mico.ts`.

use serde_json::json;

use super::*;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn clean_title_remove_sufixos_na_ordem_do_node() {
    let line = format!("Filme Dublado 1080p {EYES} 12 {DISK} 2.1 GB (brazilian, eng)");
    assert_eq!(clean_title(&line), "Filme Dublado 1080p");
    // Linha truncada no meio do sufixo de idiomas.
    assert_eq!(
        clean_title("DUAL-RICKSZ (brazili…"),
        "DUAL-RICKSZ",
        "o Mico corta a linha longa no meio do sufixo"
    );
    assert_eq!(clean_title("Filme (DUBLADO) …"), "Filme (DUBLADO)");
    assert_eq!(clean_title("Filme…"), "Filme");
}

#[test]
fn clean_title_parenteses_de_idioma_exige_lista_ascii() {
    assert_eq!(clean_title("Filme (Brazilian, Eng)"), "Filme");
    assert_eq!(
        clean_title("Filme (eng legendado)"),
        "Filme (eng legendado)",
        "espaço sem vírgula não é lista de idiomas"
    );
    assert_eq!(
        clean_title("Filme (brazilian,)"),
        "Filme (brazilian,)",
        "vírgula final não casaria a regex do Node"
    );
    assert_eq!(
        clean_title("Filme (,eng)"),
        "Filme (,eng)",
        "vírgula inicial idem"
    );
    assert_eq!(
        clean_title("Filme ( brazilian)"),
        "Filme ( brazilian)",
        "espaço depois do ( não casaria"
    );
    assert_eq!(clean_title("Filme ()"), "Filme ()");
}

#[test]
fn clean_title_pictographic_e_fiel_ao_unicode_do_node() {
    // Extended_Pictographic de verdade: ©/®/⚡/👥 saem…
    assert_eq!(clean_title("Filme © ® ⚡ 1080p"), "Filme 1080p");
    // …e o FE0F (seletor de apresentação) sai isolado.
    assert_eq!(clean_title("Filme \u{FE0F}1080p"), "Filme 1080p");
    // Caracteres que NÃO são Extended_Pictographic continuam: o aproximado
    // por blocos apagava ① (U+2460) e あ (U+3042).
    assert_eq!(clean_title("Filme ① あ ½"), "Filme ① あ ½");
    // Wavy dash (U+3030) é Extended_Pictographic e sai, como no Node.
    assert_eq!(clean_title("Filme 〰 Dublado"), "Filme Dublado");
}

#[test]
fn magnet_preserva_ordem_e_dedupe_do_set_do_node() {
    let sources = json!([
        "tracker:udp://tracker.b:80",
        "udp://tracker.a:80",
        "tracker:udp://tracker.b:80",
        "http://tracker.c/announce"
    ]);
    let magnet = magnet_of(HASH, Some(&sources));
    assert_eq!(
        magnet,
        "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\
         &tr=udp%3A%2F%2Ftracker.b%3A80\
         &tr=udp%3A%2F%2Ftracker.a%3A80\
         &tr=http%3A%2F%2Ftracker.c%2Fannounce"
    );
    assert!(!magnet.contains("dn="), "dn= é evidência de arquivo");
}

#[test]
fn magnet_ignora_tracker_invalido_e_prefixo_case_insensitive() {
    let sources = json!([
        "TRACKER:WSS://tracker.x/socket",
        "dht:abc",
        "udp://",
        "udp://com espaço",
        "http://com&nbsp",
        "https://ok/tracker#frag",
        "tracker: ws://nao-aceita-espaco"
    ]);
    let magnet = magnet_of(HASH, Some(&sources));
    assert!(magnet.contains("tr=WSS%3A%2F%2Ftracker.x%2Fsocket"));
    assert_eq!(
        magnet,
        "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\
         &tr=WSS%3A%2F%2Ftracker.x%2Fsocket"
    );
}

#[test]
fn magnet_codifica_como_encode_uri_component() {
    let sources = json!(["udp://tracker/x!(a)*'~._-"]);
    let magnet = magnet_of(HASH, Some(&sources));
    // `! * ' ( ) ~ . _ -` NÃO são escapados pelo encodeURIComponent.
    assert!(
        magnet.contains("tr=udp%3A%2F%2Ftracker%2Fx!(a)*'~._-"),
        "{magnet}"
    );
}

#[test]
fn map_stream_titulo_hash_size_seeders_e_br() {
    let line = format!("Coringa 2019 Dublado {EYES} 42 {DISK} 2.1 GB (brazilian, eng)");
    let raw = json!({
        "title": line,
        "infoHash": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sources": ["tracker:udp://tracker.example:80"]
    });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.title, "Coringa 2019 Dublado");
    assert_eq!(item.info_hash, HASH);
    assert_eq!(item.seeders, 42.0);
    assert_eq!(item.size, Some((2.1 * 1024.0_f64.powi(3)).round()));
    assert_eq!(item.indexer, "mico");
    assert!(item.is_br);
    assert!(item.magnet.contains("btih:aaaaaaaa"));
    assert!(!item.magnet.contains("dn="));
}

#[test]
fn map_stream_sem_seeders_usa_neutro_1() {
    let raw = json!({ "title": "Filme 2024", "infoHash": HASH });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.seeders, 1.0, "0 seria cortado por MIN_SEEDERS");
    assert_eq!(item.size, None);
    assert!(!item.is_br);
}

#[test]
fn map_stream_is_br_tambem_quando_o_titulo_completo_diz_brazil() {
    let raw = json!({
        "title": "Filme 2024 (Brazil)",
        "infoHash": HASH
    });
    let item = map_stream(&raw).expect("item");
    assert!(item.is_br, "/(\\(brazil/i.test(full))");
}

#[test]
fn map_stream_descarta_hash_invalido_e_titulo_vazio() {
    assert!(map_stream(&json!({ "title": "x", "infoHash": "abc" })).is_none());
    assert!(map_stream(&json!({ "title": "x", "infoHash": "z".repeat(40) })).is_none());
    assert!(map_stream(&json!({
        "title": format!("{EYES} 2"),
        "infoHash": HASH
    }))
    .is_none());
}

#[test]
fn size_aceita_valor_e_unidade_sem_espaco() {
    let raw = json!({ "title": format!("Filme {DISK} 2.1GB"), "infoHash": HASH });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.size, Some((2.1 * 1024.0_f64.powi(3)).round()));
}

#[test]
fn size_usa_o_primeiro_match_valido_do_regex() {
    // Primeiro 💾 sem valor/unidade não casa; o regex do Node avança até o
    // segundo, que casa.
    let raw = json!({
        "title": format!("Filme {DISK} x {DISK} 3 MB"),
        "infoHash": HASH
    });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.size, Some((3.0_f64 * 1024.0 * 1024.0).round()));
}

#[test]
fn size_invalido_nao_vira_numero() {
    // `Math.round(NaN)` → NaN → `size > 0` falso → undefined; o regex parou no
    // primeiro match, então o segundo 💾 não é consultado.
    let raw = json!({
        "title": format!("Filme {DISK} 1.2.3 GB {DISK} 2 GB"),
        "infoHash": HASH
    });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.size, None);
}

#[test]
fn seeders_separa_milhar_como_number_do_js() {
    let raw = json!({
        "title": format!("Filme {EYES} 1.234 {DISK} 1 GB"),
        "infoHash": HASH
    });
    let item = map_stream(&raw).expect("item");
    assert_eq!(item.seeders, 1234.0);
    let dots = json!({
        "title": format!("Filme {EYES} .."),
        "infoHash": HASH
    });
    // `Number('')` depois do replace é 0 (finito), não o neutro 1.
    assert_eq!(map_stream(&dots).expect("item").seeders, 0.0);
}

#[test]
fn titulo_usa_so_a_primeira_linha_quebrada_por_ln() {
    let raw = json!({
        "title": "Primeira linha\nSegunda linha",
        "infoHash": HASH
    });
    assert_eq!(map_stream(&raw).expect("item").title, "Primeira linha");
    // O split do JS é só em "\n": "\r" continua na linha e vira espaço.
    let cr = json!({
        "title": "Primeira\rSegunda",
        "infoHash": HASH
    });
    assert_eq!(map_stream(&cr).expect("item").title, "Primeira Segunda");
}
