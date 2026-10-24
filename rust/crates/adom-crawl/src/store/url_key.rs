//! Identidade de página no `crawl.db`: a fila é uma linha por `(site, url_key)`
//! e `url_key` é o CAMINHO da URL, não a URL inteira (porta de
//! `src/utils/crawl-url-key.ts`, decisão da Fase 8).
//!
//! Por quê o caminho: os sites BR trocam de domínio com frequência. Com a URL
//! inteira como chave, cada migração de host nasce como uma fila NOVA — as
//! linhas velhas ficam `done` no arquivo antigo e as mesmas páginas voltam a ser
//! lidas do zero. Com o caminho como identidade, a redescoberta no host novo
//! encontra a MESMA linha e o `enqueue_discovered` só atualiza o host gravado.
//!
//! Normalização: sem esquema/host, sem query, sem fragmento, `//` colapsada e
//! barra final fora (a raiz `/` é ela mesma). Nunca devolve `''` para entrada
//! não vazia: chave vazia colapsaria a fila inteira do site numa linha só.

/// Corta query e fragmento — o que não é identidade de página.
fn strip_query(url: &str) -> &str {
    let sem_fragmento = url.split('#').next().unwrap_or("");
    sem_fragmento.split('?').next().unwrap_or("")
}

/// Colapsa `//`, remove barra final e garante `/` para caminho vazio.
fn normalize_path(path: &str) -> String {
    let cut = strip_query(path);
    if cut.is_empty() {
        return "/".to_string();
    }
    let mut out = String::with_capacity(cut.len());
    let mut barra_anterior = false;
    for ch in cut.chars() {
        if ch == '/' {
            if !barra_anterior {
                out.push(ch);
            }
            barra_anterior = true;
        } else {
            out.push(ch);
            barra_anterior = false;
        }
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    if out.is_empty() {
        "/".to_string()
    } else {
        out
    }
}

/// Chave de identidade da página. Aceita URL absoluta, caminho relativo (o
/// store também guarda linhas legadas/testes sem host) e entrada malformada —
/// nunca lança e nunca devolve `''` para entrada não vazia.
pub fn crawl_url_key(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    if let Ok(parsed) = url::Url::parse(text) {
        return normalize_path(parsed.path());
    }
    // Sem host: caminho puro. `scheme://host` escrito à mão (sem parser) também
    // perde o host — mesmo efeito, e é a intenção da chave.
    let cut = strip_query(text);
    match cut.find("://") {
        None => normalize_path(cut),
        Some(at) => {
            let after_host = &cut[at + 3..];
            match after_host.find('/') {
                Some(slash) => normalize_path(&after_host[slash..]),
                None => "/".to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrai_o_caminho_e_ignora_host_query_e_fragmento() {
        assert_eq!(
            crawl_url_key("https://mico.example/crawl/movie/tt0133093/"),
            "/crawl/movie/tt0133093"
        );
        assert_eq!(
            crawl_url_key("http://outro-host/crawl/series/tt1234567?x=1#frag"),
            "/crawl/series/tt1234567"
        );
    }

    #[test]
    fn colapsa_barras_e_preserva_a_raiz() {
        assert_eq!(crawl_url_key("https://x/a//b///"), "/a/b");
        assert_eq!(crawl_url_key("https://x/"), "/");
        assert_eq!(crawl_url_key("https://x"), "/");
    }

    #[test]
    fn aceita_caminho_relativo_e_nunca_devolve_vazio() {
        assert_eq!(
            crawl_url_key("/crawl/movie/tt0133093/"),
            "/crawl/movie/tt0133093"
        );
        // Caminho relativo fica como veio (o TS não inventa barra inicial).
        assert_eq!(crawl_url_key("crawl/movie/tt1"), "crawl/movie/tt1");
        assert_eq!(crawl_url_key("   "), "");
    }
}
