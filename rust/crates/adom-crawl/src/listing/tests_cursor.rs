use super::*;
use crate::sitemap::CrawlPageKind;

fn cursor() -> ListingCursor {
    ListingCursor {
        site: "hdrtorrent-cardigann".to_string(),
        kind: CrawlPageKind::Movie,
        path: "/pagina".to_string(),
        page: 42,
        seen: 840,
        anchor: "/presidente-curtis-torrent-download".to_string(),
        round_page: 7,
        sweep: true,
        head: Some("/as-rainhas-da-torcida-baixar-torrent".to_string()),
        rounds: 3,
        updated_at: 1_790_812_800_000,
    }
}

#[test]
fn token_ida_e_volta_preserva_o_cursor() {
    let original = cursor();
    let token = encode_listing_cursor(&original);
    assert!(token.starts_with("lc1."), "tag versionada: {token}");
    let decoded = decode_listing_cursor(&token).expect("token válido");
    assert_eq!(decoded, original);
}

#[test]
fn token_e_o_mesmo_formato_que_o_ts_grava() {
    // O TS grava `{v,s,k,p,n,c,a,r,d,t}` com chaves curtas; o campo `w` só
    // aparece quando é sweep e `h` só quando há head.
    let mut c = cursor();
    c.sweep = false;
    c.head = None;
    c.anchor = String::new();
    let token = encode_listing_cursor(&c);
    let body = token.strip_prefix("lc1.").unwrap();
    let json = String::from_utf8(crate::listing::base64url::decode(body).unwrap()).unwrap();
    assert!(json.contains("\"v\":1"), "{json}");
    assert!(json.contains("\"k\":\"movie\""), "{json}");
    assert!(json.contains("\"p\":\"/pagina\""), "{json}");
    assert!(!json.contains("\"w\""), "sem sweep não grava w: {json}");
    assert!(!json.contains("\"h\""), "sem head não grava h: {json}");
}

#[test]
fn decode_recusa_token_fora_de_forma() {
    assert_eq!(decode_listing_cursor(""), None);
    assert_eq!(decode_listing_cursor("lc2.abc"), None);
    assert_eq!(decode_listing_cursor("lc1"), None, "sem ponto");
    assert_eq!(decode_listing_cursor("lc1.nao-e-base64!"), None);
    // JSON válido, mas versão errada.
    let bad_version = format!(
        "lc1.{}",
        crate::listing::base64url::encode(
            br#"{"v":2,"s":"x","k":"movie","p":"/p","n":1,"c":0,"t":0}"#
        )
    );
    assert_eq!(decode_listing_cursor(&bad_version), None);
    // Kind fora do vocabulário.
    let bad_kind = format!(
        "lc1.{}",
        crate::listing::base64url::encode(
            br#"{"v":1,"s":"x","k":"anime","p":"/p","n":1,"c":0,"t":0}"#
        )
    );
    assert_eq!(decode_listing_cursor(&bad_kind), None);
    // Site vazio, caminho raiz e página zero são todos inválidos.
    for body in [
        r#"{"v":1,"s":"","k":"movie","p":"/p","n":1,"c":0,"t":0}"#,
        r#"{"v":1,"s":"x","k":"movie","p":"/","n":1,"c":0,"t":0}"#,
        r#"{"v":1,"s":"x","k":"movie","p":"/p","n":0,"c":0,"t":0}"#,
    ] {
        let token = format!("lc1.{}", crate::listing::base64url::encode(body.as_bytes()));
        assert_eq!(decode_listing_cursor(&token), None, "{body}");
    }
}

#[test]
fn decode_trata_ancora_ausente_vazia_e_corrompida() {
    let make = |extra: &str| {
        let json =
            format!(r#"{{"v":1,"s":"x","k":"movie","p":"/pagina","n":1,"c":0,"t":0{extra}}}"#);
        format!("lc1.{}", crate::listing::base64url::encode(json.as_bytes()))
    };
    // Ausente = "sem marco" (token anterior à âncora), não token ruim.
    assert_eq!(
        decode_listing_cursor(&make("")).unwrap().anchor,
        String::new()
    );
    // Vazia também é "sem marco".
    assert_eq!(
        decode_listing_cursor(&make(r#","a":"""#)).unwrap().anchor,
        String::new()
    );
    // Caminho raiz não é marco: recomeçar a listagem é o lado barato.
    assert_eq!(decode_listing_cursor(&make(r#","a":"/""#)), None);
    // `h` inválido invalida o token inteiro.
    assert_eq!(decode_listing_cursor(&make(r#","h":"/""#)), None);
}

#[test]
fn decode_adota_token_anterior_aos_contadores() {
    let json = r#"{"v":1,"s":"x","k":"tv_show","p":"/pagina","n":3,"c":10,"a":"/obra","t":99}"#;
    let token = format!("lc1.{}", crate::listing::base64url::encode(json.as_bytes()));
    let c = decode_listing_cursor(&token).expect("token antigo é aceito");
    assert_eq!(c.round_page, 0);
    assert_eq!(c.rounds, 0);
    assert!(!c.sweep);
    assert_eq!(c.head, None);
    assert_eq!(c.kind, CrawlPageKind::TvShow);
    assert_eq!(c.anchor, "/obra");
}

#[test]
fn chave_do_cursor_e_por_kind_e_caminho() {
    assert_eq!(
        listing_cursor_key(CrawlPageKind::Movie, "/pagina/"),
        "listing:movie:/pagina"
    );
    assert_eq!(
        listing_cursor_key(CrawlPageKind::Movie, "https://apachetorrents.com/pagina/"),
        "listing:movie:/pagina"
    );
    assert_ne!(
        listing_cursor_key(CrawlPageKind::Movie, "/pagina"),
        listing_cursor_key(CrawlPageKind::TvShow, "/pagina")
    );
}

#[test]
fn start_zerado_e_carga_inicial() {
    let c = start_listing_cursor("hdr", CrawlPageKind::Movie, "/pagina/", 1_000);
    assert_eq!(c.page, 1);
    assert_eq!(c.seen, 0);
    assert_eq!(c.anchor, "");
    assert_eq!(c.round_page, 0);
    assert_eq!(c.rounds, 0);
    assert!(!c.sweep);
    assert_eq!(c.head, None);
    assert_eq!(c.path, "/pagina");
    assert_eq!(c.updated_at, 1_000);
}

#[test]
fn tetos_de_round_e_de_profundidade() {
    let mut c = cursor();
    c.round_page = 20;
    assert!(listing_round_exhausted(&c, 20));
    assert!(!listing_round_exhausted(&c, 0), "0 desliga o teto");
    assert!(!listing_round_exhausted(&c, 21));

    c.page = 2123;
    assert!(!listing_cursor_exhausted(&c, 0), "0 desliga o teto");
    assert!(listing_cursor_exhausted(&c, 2122));
    assert!(!listing_cursor_exhausted(&c, 2123));
}

#[test]
fn restart_do_round_preserva_marco_e_posicao() {
    let c = cursor();
    let restarted = restart_listing_round(&c, 7_000);
    assert_eq!(restarted.round_page, 0);
    assert_eq!(restarted.updated_at, 7_000);
    assert_eq!(restarted.page, c.page);
    assert_eq!(restarted.anchor, c.anchor);
    assert_eq!(restarted.head, c.head);
    assert_eq!(restarted.seen, c.seen);
}
