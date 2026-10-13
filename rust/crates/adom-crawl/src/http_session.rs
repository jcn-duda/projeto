//! Sessão HTTP com cookies persistentes para sites PHP (ApacheTorrent, etc.).
//!
//! Mantém um mapa de cookies entre requisições, permitindo que o raspador
//! reutilize sessões PHPSESSID/token sem re-autenticar a cada página.
//! Thread-safe via `Arc<Mutex<>>`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Sessão HTTP que acumula cookies entre requisições.
///
/// Equivalente Rust do mecanismo de sessão dos perfis TS.
/// Os cookies são armazenados num `HashMap` protegido por `Mutex`.
pub struct HttpSession {
    cookies: Arc<Mutex<HashMap<String, String>>>,
}

impl HttpSession {
    /// Cria uma sessão vazia, sem cookies.
    pub fn new() -> Self {
        Self {
            cookies: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Define (ou atualiza) um cookie na sessão.
    pub fn set_cookie(&self, name: &str, value: &str) {
        if let Ok(mut cookies) = self.cookies.lock() {
            cookies.insert(name.to_string(), value.to_string());
        }
    }

    /// Monta o header `Cookie` no formato `"name=value; name2=value2"`.
    ///
    /// Retorna string vazia se não houver cookies na sessão.
    pub fn get_cookie_header(&self) -> String {
        let cookies = match self.cookies.lock() {
            Ok(guard) => guard,
            Err(_) => return String::new(),
        };
        cookies
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// Extrai cookies de um `HeaderMap` de resposta (headers `Set-Cookie`).
    ///
    /// Parseia apenas o par `name=value` inicial de cada `Set-Cookie`,
    /// ignorando atributos como `Path`, `HttpOnly`, `Expires`, etc.
    pub fn harvest_from_headers(&self, headers: &reqwest::header::HeaderMap) {
        let mut cookies = match self.cookies.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        for value in headers.get_all(reqwest::header::SET_COOKIE) {
            if let Ok(cookie_str) = value.to_str() {
                if let Some((name, val)) = parse_set_cookie(cookie_str) {
                    cookies.insert(name, val);
                }
            }
        }
    }

    /// Retorna o número de cookies atualmente na sessão.
    pub fn cookie_count(&self) -> usize {
        self.cookies.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Remove um cookie da sessão por nome.
    pub fn remove_cookie(&self, name: &str) {
        if let Ok(mut cookies) = self.cookies.lock() {
            cookies.remove(name);
        }
    }

    /// Limpa todos os cookies da sessão.
    pub fn clear(&self) {
        if let Ok(mut cookies) = self.cookies.lock() {
            cookies.clear();
        }
    }
}

impl Default for HttpSession {
    fn default() -> Self {
        Self::new()
    }
}

/// Parseia um header `Set-Cookie` no formato `"name=value; Path=/; ..."`.
///
/// Retorna apenas o par `(name, value)` do primeiro segmento (antes do `;`).
/// Retorna `None` se o header for mal-formado (sem `=`, nome vazio, etc.).
fn parse_set_cookie(header: &str) -> Option<(String, String)> {
    // Pega apenas o primeiro segmento (antes do primeiro `;`).
    let first_segment = header.split(';').next()?.trim();
    if first_segment.is_empty() {
        return None;
    }

    let eq_pos = first_segment.find('=')?;
    let name = first_segment[..eq_pos].trim().to_string();
    let value = first_segment[eq_pos + 1..].trim().to_string();

    if name.is_empty() {
        return None;
    }
    Some((name, value))
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// set_cookie + get_cookie_header monta o header correto.
    #[test]
    fn set_cookie_e_get_cookie_header() {
        let session = HttpSession::new();
        session.set_cookie("PHPSESSID", "abc123");
        session.set_cookie("token", "xyz789");

        let header = session.get_cookie_header();
        assert!(header.contains("PHPSESSID=abc123"));
        assert!(header.contains("token=xyz789"));
        assert!(header.contains("; "));
    }

    /// get_cookie_header retorna vazio quando não há cookies.
    #[test]
    fn get_cookie_header_vazio() {
        let session = HttpSession::new();
        assert_eq!(session.get_cookie_header(), "");
    }

    /// harvest_from_headers extrai Set-Cookie corretamente.
    #[test]
    fn harvest_extrai_set_cookie() {
        let session = HttpSession::new();
        let mut headers = reqwest::header::HeaderMap::new();

        headers.append(
            reqwest::header::SET_COOKIE,
            "PHPSESSID=newsession123; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "token=mytoken456; Path=/; Secure".parse().unwrap(),
        );

        session.harvest_from_headers(&headers);

        let header = session.get_cookie_header();
        assert!(header.contains("PHPSESSID=newsession123"));
        assert!(header.contains("token=mytoken456"));
        assert_eq!(session.cookie_count(), 2);
    }

    /// harvest_from_headers com valor sem atributos (só name=value).
    #[test]
    fn harvest_sem_atributos() {
        let session = HttpSession::new();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(reqwest::header::SET_COOKIE, "simple=value".parse().unwrap());
        session.harvest_from_headers(&headers);

        let header = session.get_cookie_header();
        assert!(header.contains("simple=value"));
    }

    /// harvest_from_headers ignora Set-Cookie mal-formado.
    #[test]
    fn harvest_ignora_mal_formado() {
        let session = HttpSession::new();
        let mut headers = reqwest::header::HeaderMap::new();
        // Sem `=` → inválido
        headers.append(reqwest::header::SET_COOKIE, "malformado".parse().unwrap());
        session.harvest_from_headers(&headers);

        assert_eq!(session.cookie_count(), 0);
    }

    /// Sobrescrever cookie existente atualiza o valor.
    #[test]
    fn sobrescreve_cookie() {
        let session = HttpSession::new();
        session.set_cookie("id", "valor_antigo");
        session.set_cookie("id", "valor_novo");

        let header = session.get_cookie_header();
        assert!(header.contains("id=valor_novo"));
        assert!(!header.contains("id=valor_antigo"));
        assert_eq!(session.cookie_count(), 1);
    }

    /// remove_cookie remove apenas o cookie especificado.
    #[test]
    fn remove_cookie() {
        let session = HttpSession::new();
        session.set_cookie("a", "1");
        session.set_cookie("b", "2");
        session.remove_cookie("a");

        let header = session.get_cookie_header();
        assert!(!header.contains("a="));
        assert!(header.contains("b=2"));
        assert_eq!(session.cookie_count(), 1);
    }

    /// clear limpa todos os cookies.
    #[test]
    fn clear_limpa_tudo() {
        let session = HttpSession::new();
        session.set_cookie("a", "1");
        session.set_cookie("b", "2");
        session.clear();

        assert_eq!(session.get_cookie_header(), "");
        assert_eq!(session.cookie_count(), 0);
    }

    /// parse_set_cookie unitário.
    #[test]
    fn parse_set_cookie_valido() {
        let (name, value) = parse_set_cookie("PHPSESSID=abc; Path=/; HttpOnly").unwrap();
        assert_eq!(name, "PHPSESSID");
        assert_eq!(value, "abc");
    }

    /// parse_set_cookie com valor que contém `=`.
    #[test]
    fn parse_set_cookie_valor_com_equals() {
        let (name, value) = parse_set_cookie("token=abc=def; Path=/").unwrap();
        assert_eq!(name, "token");
        assert_eq!(value, "abc=def");
    }

    /// parse_set_cookie com entrada inválida retorna None.
    #[test]
    fn parse_set_cookie_invalido() {
        assert!(parse_set_cookie("semigual").is_none());
        assert!(parse_set_cookie("").is_none());
        assert!(parse_set_cookie("=valor").is_none());
    }
}
