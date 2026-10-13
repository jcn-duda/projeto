//! Port de `resolvers/nested-url.ts` — desempacotamento de URL aninhada.
//!
//! Cardigann pode encapsular repetidamente a URL de `/resolve` no parâmetro `url`.
//! Esta função desfaz até 3 saltos de encapsulamento, extraindo também campos
//! propagados (índice, hash, count).

use std::collections::HashMap;
use url::Url;

// ── Tipos públicos ───────────────────────────────────────────────────────────

/// Valores iniciais dos campos (seed) que o cardigann propaga.
///
/// Corresponde a `UnwrapResolverSeed` em `nested-url.ts`.
#[derive(Debug, Clone, Default)]
pub struct UnwrapSeed {
    /// Campos livres (ex: index, hash, count, audio, quality).
    pub fields: HashMap<String, Option<String>>,
}

/// Opções do desempacotamento.
///
/// Corresponde a `UnwrapResolverOptions` em `nested-url.ts`.
#[derive(Debug, Clone)]
pub struct UnwrapOptions {
    /// Pathnames que caracterizam um salto de resolve (padrão: `["/resolve"]`).
    pub paths: Vec<String>,
    /// Mapeamento nome do campo → parâmetro de query (padrão: index→i, hash→h, count→n).
    pub field_params: HashMap<String, String>,
}

impl Default for UnwrapOptions {
    fn default() -> Self {
        let mut field_params = HashMap::new();
        field_params.insert("index".to_string(), "i".to_string());
        field_params.insert("hash".to_string(), "h".to_string());
        field_params.insert("count".to_string(), "n".to_string());
        Self {
            paths: vec!["/resolve".to_string()],
            field_params,
        }
    }
}

/// URL final após desempacotamento, com os campos extraídos.
///
/// Corresponde a `UnwrappedResolverUrl` em `nested-url.ts`.
#[derive(Debug, Clone)]
pub struct UnwrappedUrl {
    /// URL final (pode ser a mesma de entrada se não houve saltos).
    pub url: String,
    /// Campos extraídos durante o desempacotamento (index, hash, count, etc.).
    pub fields: HashMap<String, Option<String>>,
}

// ── Função pública ───────────────────────────────────────────────────────────

/// Desempacota URL aninhada em até 3 saltos.
///
/// Equivalente a `unwrapResolverUrl` em `resolvers/nested-url.ts:21-49`.
///
/// A cada salto, se a URL apontar para um path de resolve (ex: `/resolve`) e
/// tiver um parâmetro `url`, extrai esse parâmetro como a próxima URL. Os
/// campos configurados em `field_params` são extraídos dos parâmetros de query
/// a cada salto (o primeiro valor encontrado prevalece).
pub fn unwrap_resolver_url(
    value: &str,
    self_url: &str,
    seed: &UnwrapSeed,
    options: Option<&UnwrapOptions>,
) -> UnwrappedUrl {
    let opts = options.cloned().unwrap_or_default();
    let mut url_str = value.to_string();

    // Inicializa o resultado com os campos do seed (ou None se ausente).
    let mut result_fields: HashMap<String, Option<String>> = opts
        .field_params
        .keys()
        .map(|field| {
            let value = seed.fields.get(field.as_str()).cloned().flatten();
            (field.clone(), value)
        })
        .collect();
    // Preserva campos extras do seed que não estão em field_params.
    for (key, value) in &seed.fields {
        if !result_fields.contains_key(key) {
            result_fields.insert(key.clone(), value.clone());
        }
    }

    // Até 3 saltos de encapsulamento.
    for _hop in 0..3 {
        // Tenta parsear como URL absoluta; se falhar, resolve relativa à base.
        let inner = match Url::parse(&url_str) {
            Ok(u) => u,
            Err(_) => {
                // URL relativa: resolve em relação a self_url.
                match Url::parse(self_url) {
                    Ok(base) => match base.join(&url_str) {
                        Ok(u) => u,
                        Err(_) => break,
                    },
                    Err(_) => break,
                }
            }
        };

        // Verifica se o pathname é um dos paths de resolve.
        let path = inner.path();
        if !opts.paths.iter().any(|p| p == path) {
            break;
        }

        // Extrai o parâmetro `url`; se ausente, para.
        let inner_target = match inner.query_pairs().find(|(k, _)| k == "url") {
            Some((_, v)) => v.to_string(),
            None => break,
        };

        url_str = inner_target;

        // Extrai campos dos parâmetros de query (primeiro valor encontrado).
        for (field, param) in &opts.field_params {
            if result_fields.get(field).is_none()
                || result_fields.get(field).unwrap().is_none()
            {
                let value = inner
                    .query_pairs()
                    .find(|(k, _)| k == param)
                    .map(|(_, v): (std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)| v.to_string());
                if value.is_some() {
                    result_fields.insert(field.clone(), value);
                }
            }
        }
    }

    UnwrappedUrl {
        url: url_str,
        fields: result_fields,
    }
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_seed() -> UnwrapSeed {
        UnwrapSeed {
            fields: HashMap::new(),
        }
    }

    #[test]
    fn url_sem_encapsulamento() {
        let result = unwrap_resolver_url(
            "https://example.com/filme/post-123",
            "https://resolver.example.com",
            &empty_seed(),
            None,
        );
        assert_eq!(result.url, "https://example.com/filme/post-123");
    }

    #[test]
    fn um_salto_de_resolve() {
        let nested = "https://resolver.example.com/resolve?url=https%3A%2F%2Fexample.com%2Ffilme%2Fpost-123";
        let result = unwrap_resolver_url(
            nested,
            "https://resolver.example.com",
            &empty_seed(),
            None,
        );
        assert_eq!(result.url, "https://example.com/filme/post-123");
    }

    #[test]
    fn dois_saltos_de_resolve() {
        let inner = "https://resolver.example.com/resolve?url=https%3A%2F%2Fexample.com%2Ffilme";
        let outer = format!(
            "https://resolver.example.com/resolve?url={}",
            url::form_urlencoded::byte_serialize(inner.as_bytes()).collect::<String>()
        );
        let result = unwrap_resolver_url(
            &outer,
            "https://resolver.example.com",
            &empty_seed(),
            None,
        );
        assert_eq!(result.url, "https://example.com/filme");
    }

    #[test]
    fn extrai_campos_de_query() {
        let nested = "https://resolver.example.com/resolve?url=https%3A%2F%2Fexample.com%2Ffilme&i=2&h=abc123&n=5";
        let result = unwrap_resolver_url(
            nested,
            "https://resolver.example.com",
            &empty_seed(),
            None,
        );
        assert_eq!(result.url, "https://example.com/filme");
        assert_eq!(
            result.fields.get("index").cloned().flatten(),
            Some("2".to_string())
        );
        assert_eq!(
            result.fields.get("hash").cloned().flatten(),
            Some("abc123".to_string())
        );
        assert_eq!(
            result.fields.get("count").cloned().flatten(),
            Some("5".to_string())
        );
    }

    #[test]
    fn seed_prevalece_quando_param_ausente() {
        let nested = "https://resolver.example.com/resolve?url=https%3A%2F%2Fexample.com%2Ffilme";
        let mut seed = UnwrapSeed {
            fields: HashMap::new(),
        };
        seed.fields.insert("index".to_string(), Some("7".to_string()));
        let result = unwrap_resolver_url(
            nested,
            "https://resolver.example.com",
            &seed,
            None,
        );
        // Seed não é sobrescrito quando o parâmetro está ausente.
        assert_eq!(
            result.fields.get("index").cloned().flatten(),
            Some("7".to_string())
        );
    }

    #[test]
    fn path_diferente_de_resolve_nao_desempacota() {
        let url = "https://resolver.example.com/other?url=https%3A%2F%2Fexample.com%2Ffilme";
        let result = unwrap_resolver_url(
            url,
            "https://resolver.example.com",
            &empty_seed(),
            None,
        );
        // Não desempacota porque o path é /other, não /resolve.
        assert_eq!(result.url, url);
    }

    #[test]
    fn url_invalida_retorna_original() {
        let result = unwrap_resolver_url(
            "not a valid url at all ::: ///",
            "also invalid",
            &empty_seed(),
            None,
        );
        assert_eq!(result.url, "not a valid url at all ::: ///");
    }
}
