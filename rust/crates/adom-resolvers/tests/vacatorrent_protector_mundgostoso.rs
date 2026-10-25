//! Segunda metade da cadeia do protetor do Vaca (medida em 2026-10-24):
//! `relay.php` → `mundgostoso.site/enc/receber.php` → artigo com contagem
//! (`var URL_ETAPA2`) → `mundgostoso.site/enc2/receber.php` → página com o
//! magnet em `<body data-link="base64">`. Sem `mundgostoso.site` na lista do
//! protetor a etapa 2 era recusada e o `/resolve` acabava em "sem magnet no
//! HTML final" — o dublado do Vaca sumia da lista (Lanternas S01E08).

use adom_resolvers::common::magnet::VACA;
use adom_resolvers::sites::vacatorrent::protector::next_protected_url;

const ETAPA2: &str = "https://mundgostoso.site/enc2/receber.php?enc=abc123&pub=PUB_X";

#[test]
fn artigo_da_contagem_leva_para_a_etapa_2_no_mesmo_host() {
    let html = r#"<html><body><script>
      var SEGUNDOS_INICIAL        = 60;
      var URL_ETAPA2              = "https:\/\/mundgostoso.site\/enc2\/receber.php?enc=abc123&pub=PUB_X";
      var CONTAR_URL              = "https:\/\/mundgostoso.site\/enc\/contar.php";
    </script></body></html>"#;
    let next = next_protected_url(html, "https://mundgostoso.site/brigadeirao-rapido-e-facil/");
    assert_eq!(next.as_deref(), Some(ETAPA2));
}

#[test]
fn etapa_2_entrega_o_magnet_do_data_link_em_base64() {
    let html = concat!(
        r#"<html><body data-enc="eHl6" data-link=""#,
        "bWFnbmV0Oj94dD11cm46YnRpaDoxNTYxNGZlOWMyOTJiZjc5MDJhZjNhYjNjZTRmZjlmYWFjZDI3ZGVhJmRuPUxhbnRlcm5hcytTMDFFMDgrV0VCLURMKzEwODBwK3gyNjQrRFVBTCs1LjE=",
        r#""><a id="btn-dl">ABRIR MAGNET</a></body></html>"#
    );
    let magnet = VACA.extract(html).expect("magnet da etapa 2");
    assert!(magnet.starts_with("magnet:?xt=urn:btih:15614fe9c292bf7902af3ab3ce4ff9faacd27dea"));
    assert!(
        magnet.contains("Lanternas"),
        "o dn do episódio pedido vem junto"
    );
}

#[test]
fn host_desconhecido_continua_recusado_como_salto() {
    let html =
        r#"<script>var URL_ETAPA2 = "https:\/\/evil.example\/enc2\/receber.php?enc=x";</script>"#;
    assert_eq!(
        next_protected_url(html, "https://mundgostoso.site/receita/"),
        None,
        "a lista do protetor não vira porta aberta"
    );
}
