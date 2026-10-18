use super::*;
use adom_core::verify_resolve;

fn signer() -> ResolveSigner {
    ResolveSigner {
        prefix: "/e30".into(),
        secret: "segredo-de-teste".into(),
        season: None,
        episode: None,
        imdb_id: Some("tt0133093".into()),
        work_hint: Some(WorkHint {
            names: vec!["The Matrix".into(), "Matrix".into()],
            year: Some(1999),
        }),
    }
}

#[test]
fn url_do_corpus_bate_a_forma_do_node() {
    let url = signer().url("8cc4fdc2c777d1464d9043397309f45859b9297b", true, false);
    // Forma capturada em `rust/golden/stream-e2e/cases/movie-matrix`.
    assert!(url.starts_with(
            "/e30/resolve/8cc4fdc2c777d1464d9043397309f45859b9297b?w=%7B%22n%22%3A%5B%22The%20Matrix%22%2C%22Matrix%22%5D%2C%22y%22%3A1999%2C%22d%22%3A1%2C%22i%22%3A%22tt0133093%22%7D&sig="
        ), "{url}");
}

#[test]
fn hmac_cobre_hash_episodio_e_dica() {
    let signer = ResolveSigner {
        season: Some(1),
        episode: Some(2),
        ..signer()
    };
    let url = signer.url("0123456789abcdef0123456789abcdef01234567", true, true);
    assert!(url.contains("/resolve/0123456789abcdef0123456789abcdef01234567?s=1&e=2&w="));
    let sig = url.rsplit("sig=").next().unwrap();
    let hint = "{\"n\":[\"The Matrix\",\"Matrix\"],\"y\":1999,\"p\":1,\"d\":1,\"i\":\"tt0133093\"}";
    assert!(verify_resolve(
        "0123456789abcdef0123456789abcdef01234567",
        "?s=1&e=2",
        Some(sig),
        hint,
        "segredo-de-teste"
    ));
    // Signature do host não entra no payload: trocar o prefixo não muda o sig.
    let outro = ResolveSigner {
        prefix: String::new(),
        ..signer.clone()
    };
    let url2 = outro.url("0123456789abcdef0123456789abcdef01234567", true, true);
    assert_eq!(url2.rsplit("sig=").next(), Some(sig));
}

#[test]
fn sem_dica_o_payload_e_so_hash_e_ep() {
    let signer = ResolveSigner {
        secret: "k".into(),
        ..ResolveSigner::default()
    };
    let url = signer.url("aa", false, false);
    assert_eq!(
        url,
        format!(
            "/resolve/aa?sig={}",
            adom_core::sign_resolve("aa", "", "", "k")
        )
    );
}

#[test]
fn segredo_vazio_nao_assinavel() {
    let signer = ResolveSigner::default();
    assert!(signer.url("aa", false, false).ends_with("sig="));
}

#[test]
fn encode_uri_component_igual_ao_js() {
    assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
    assert_eq!(
        encode_uri_component("{\"n\":[\"A B\"]}"),
        "%7B%22n%22%3A%5B%22A%20B%22%5D%7D"
    );
    assert_eq!(encode_uri_component("ção"), "%C3%A7%C3%A3o");
}

#[test]
fn decode_uri_component_inverso() {
    let raw = "{\"n\":[\"A B\"],\"p\":1}";
    assert_eq!(decode_uri_component(&encode_uri_component(raw)), raw);
    assert_eq!(decode_uri_component("%7b%22a%22%3a1%7d"), "{\"a\":1}");
}

#[test]
fn parse_resolve_path_com_e_sem_config() {
    let (enc, hash) =
        parse_resolve_path("/resolve/8cc4fdc2c777d1464d9043397309f45859b9297b").unwrap();
    assert!(enc.is_none());
    assert_eq!(hash, "8cc4fdc2c777d1464d9043397309f45859b9297b");

    let (enc, hash) =
        parse_resolve_path("/e30/resolve/0123456789ABCDEF0123456789ABCDEF01234567").unwrap();
    assert_eq!(enc.as_deref(), Some("e30"));
    assert_eq!(hash, "0123456789ABCDEF0123456789ABCDEF01234567");

    assert!(parse_resolve_path("/stream/movie/tt1.json").is_none());
    assert!(parse_resolve_path("/resolve/").is_none());
    assert!(parse_resolve_path("/resolve/aa/extra").is_none());
}

#[test]
fn verify_resolve_play_aceita_url_assinada() {
    let signer = ResolveSigner {
        season: Some(1),
        episode: Some(2),
        ..signer()
    };
    // Assina com maiúsculas no argumento — o signer normaliza; o verify
    // também lowercasa o path (espelho do Node).
    let url = signer.url("0123456789ABCDEF0123456789ABCDEF01234567", true, true);
    let (path, query) = url.split_once('?').unwrap();
    let play = resolve_play_from(path, Some(query)).unwrap();
    assert_eq!(play.info_hash, "0123456789abcdef0123456789abcdef01234567");
    assert_eq!(play.ep, "?s=1&e=2");
    assert!(play.hint.contains("\"p\":1"), "hint={}", play.hint);
    assert_eq!(
        verify_resolve_play(&play, "segredo-de-teste"),
        ResolveVerify::Ok
    );
}

#[test]
fn verify_resolve_play_rejeita_sig_errada_e_hash_curto() {
    let play = ResolvePlay {
        info_hash: "0123456789abcdef0123456789abcdef01234567".into(),
        encoded: None,
        ep: String::new(),
        hint: String::new(),
        sig: Some("00".repeat(32)),
    };
    assert_eq!(
        verify_resolve_play(&play, "segredo-de-teste"),
        ResolveVerify::Forbidden
    );

    let curto = ResolvePlay {
        info_hash: "aa".into(),
        ..play.clone()
    };
    assert_eq!(
        verify_resolve_play(&curto, "segredo-de-teste"),
        ResolveVerify::InvalidHash
    );

    assert_eq!(verify_resolve_play(&play, ""), ResolveVerify::Unsigned);
}

#[test]
fn effective_secret_precede_resolve_sobre_dk() {
    assert_eq!(effective_resolve_secret("sec", "dk"), "sec");
    assert_eq!(effective_resolve_secret("", "dk"), "dk");
    assert_eq!(effective_resolve_secret("", ""), "");
}
