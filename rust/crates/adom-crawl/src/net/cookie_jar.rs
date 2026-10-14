//! CookieJar por hostname para o raspador de sites BR.
//!
//! Porta do `createCookieJar` do `resolvers/transport.ts` (linhas 41-74):
//! guarda `Set-Cookie` por hostname e reenvia como header `Cookie` SOMENTE
//! quando o próximo hop tem o MESMO hostname (não vaza cookie entre hosts).

use std::collections::HashMap;

/// Jar de cookies opt-in, local a cada cadeia de redirects.
///
/// Aceita seed pré-populado (cookies conhecidos antes do primeiro fetch) e
/// colhe `Set-Cookie` das respostas. Reenvia como `Cookie` apenas no mesmo
/// hostname — um salto para host diferente NÃO leva o cookie.
#[derive(Debug, Clone)]
pub struct CookieJar {
    /// Cookies coletados por hostname (minúsculo).
    cookies: HashMap<String, HashMap<String, String>>,
    /// Cookies pré-populados no formato `"nome=valor"` por hostname.
    seed: HashMap<String, String>,
}

impl CookieJar {
    /// Jar vazio (só colhe da rede).
    pub fn new() -> Self {
        Self {
            cookies: HashMap::new(),
            seed: HashMap::new(),
        }
    }

    /// Jar com seed pré-populado.
    ///
    /// O seed é um mapa `hostname → "nome=valor"` (um único par por entrada)
    /// ou `hostname → "nome1=val1; nome2=val2"` (múltiplos pares separados
    /// por `;`). O parser reusa a mesma lógica do `harvest().from()`.
    pub fn with_seed(seed: HashMap<String, String>) -> Self {
        let mut jar = Self::new();
        // Pré-popula usando o mesmo parser de Set-Cookie.
        for (host, raw) in &seed {
            let hostname = host.to_lowercase();
            jar.ensure_host(&hostname);
            jar.parse_and_store(&hostname, raw);
        }
        jar.seed = seed;
        jar
    }

    /// Armazena cookies do header `Set-Cookie` de uma resposta reqwest.
    ///
    /// Porta do `jar.harvest(hostname).from(response.headers.get('set-cookie'))`.
    ///_reqwest_ pode retornar múltiplos `Set-Cookie` (um por valor); iteramos
    /// todos com `get_all`.
    pub fn store_from_response(&mut self, response: &reqwest::Response, hostname: &str) {
        let host = hostname.to_lowercase();
        self.ensure_host(&host);

        for value in response.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(raw) = value.to_str() {
                self.parse_and_store(&host, raw);
            }
        }
    }

    /// Monta o header `Cookie` para o hostname: `"key=val; key2=val2"`.
    ///
    /// Retorna `None` quando não há cookies para o host.
    /// Porta do `jar.headers(hostname)` do transport.ts.
    pub fn headers_for(&self, hostname: &str) -> Option<String> {
        let host = hostname.to_lowercase();
        let map = self.cookies.get(&host)?;
        if map.is_empty() {
            return None;
        }
        let header = map
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        Some(header)
    }

    // ── internos ──────────────────────────────────────────────────────

    /// Garante que o hostname tem entrada no mapa.
    fn ensure_host(&mut self, hostname: &str) {
        if !self.cookies.contains_key(hostname) {
            self.cookies.insert(hostname.to_string(), HashMap::new());
        }
    }

    /// Parseia um raw `Set-Cookie` (ou `"nome=valor"` do seed) e armazena.
    ///
    /// Porta do `harvest(host).from(raw)`:
    /// - Quebra por `,` (Node/undici junta vários Set-Cookie com ", ").
    /// - Pega só o par `name=value` antes do primeiro `;`.
    /// - O valor pode conter `=`; só o primeiro separa name de value.
    pub(crate) fn parse_and_store(&mut self, hostname: &str, raw: &str) {
        let dest = match self.cookies.get_mut(hostname) {
            Some(map) => map,
            None => {
                self.ensure_host(hostname);
                self.cookies.get_mut(hostname).unwrap()
            }
        };

        for part in raw.split(',') {
            let pair = part.split(';').next().unwrap_or("");
            let eq = match pair.find('=') {
                Some(pos) if pos > 0 => pos,
                _ => continue,
            };
            let name = pair[..eq].trim().to_string();
            let value = pair[eq + 1..].trim().to_string();
            if !name.is_empty() {
                dest.insert(name, value);
            }
        }
    }
}

impl Default for CookieJar {
    fn default() -> Self {
        Self::new()
    }
}
