//! Máscara de segredos em texto de log.
//!
//! O `Display` do `reqwest::Error` carrega a URL inteira, query incluída: o
//! `Link` de download do Jackett leva `jackett_apikey`, o TMDB leva `api_key` e
//! o Prowlarr `apikey`. Medido na VPS (2026-10-23): a chave do Jackett saía em
//! texto puro no `docker logs` a cada download que falhava. Todo log de erro
//! de rede ou de URL deste crate passa por aqui antes do `eprintln!`.

use std::sync::LazyLock;

use regex::Regex;

/// Parâmetro de query que carrega credencial. Só o VALOR some; o nome fica para
/// o log continuar dizendo qual chave estava na URL.
static SECRET_PARAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([?&](?:jackett_apikey|apikey|api_key|access_token|token)=)[^&\s)"'#>]+"#)
        .expect("regex de segredo de query")
});

/// Texto com o valor de todo parâmetro de credencial trocado por `<redacted>`.
pub(crate) fn redact_secrets(text: &str) -> String {
    SECRET_PARAM_RE
        .replace_all(text, "${1}<redacted>")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::redact_secrets;

    #[test]
    fn mascara_a_chave_do_link_de_download_do_jackett() {
        // Forma do erro do reqwest medida no log da VPS.
        let msg = "error sending request for url (http://127.0.0.1:9117/dl/limetorrents/?jackett_apikey=fakekey0000000000000000000000000&path=Q2ZESjhQ&file=x.torrent)";
        let out = redact_secrets(msg);
        assert!(!out.contains("fakekey0000000000000000000000000"), "{out}");
        assert!(
            out.contains("jackett_apikey=<redacted>&path=Q2ZESjhQ"),
            "{out}"
        );
        assert!(
            out.ends_with("file=x.torrent)"),
            "o resto da URL fica: {out}"
        );
    }

    #[test]
    fn mascara_apikey_do_prowlarr_e_api_key_do_tmdb_em_qualquer_caixa() {
        let out = redact_secrets("http://p/api/v1/search?query=x&ApiKey=abc123 e https://api.themoviedb.org/3/find/tt1?api_key=def456");
        assert_eq!(
            out,
            "http://p/api/v1/search?query=x&ApiKey=<redacted> e https://api.themoviedb.org/3/find/tt1?api_key=<redacted>"
        );
    }

    #[test]
    fn texto_sem_credencial_fica_igual() {
        let msg = "operation timed out for url (http://127.0.0.1:9117/api/v2.0/indexers/x/results?Query=keyword&cat=2000)";
        assert_eq!(redact_secrets(msg), msg, "`Query=keyword` não é credencial");
    }
}
