//! Aquecimento do cache de listagem dos resolvers (SWR).
//!
//! Placeholder — a implementação real depende do resolver_cache (R2 cache)
//! e do parser de listagem de cada site (HDR, Apache, etc.).
//! No TS, o warm do HDR raspia a listagem com SWR para popular o cache
//! antes da primeira busca do usuário.

/// Aquecimento do cache de listagem do HDR (SWR).
///
/// Placeholder — será implementado quando o resolver_cache e o parser
/// do HDR estiverem prontos no crate `adom-crawl`.
///
/// No TS original (`resolvers/hdr.ts`), o warm visita a listagem paginada,
/// parseia os resultados e os armazena em cache com staleness (SWR).
pub async fn warm_hdr(_cache: &()) -> Result<(), String> {
    // TODO: implementar quando o resolver_cache e o parser do HDR estiverem prontos.
    // O fluxo será:
    //   1. Buscar a primeira página da listagem do HDR
    //   2. Parsear os itens (título, ano, URL, qualidade)
    //   3. Armazenar no resolver_cache com TTL SWR
    //   4. Retornar Ok(()) para sinalizar que o cache está aquecido
    Ok(())
}

/// Aquecimento genérico para qualquer resolver com listagem paginada.
///
/// Placeholder — a assinatura final dependerá do tipo de cache (R2 cache)
/// e do trait de parser de listagem.
pub async fn warm_listing_generic(
    _site: &str,
    _cache: &(),
) -> Result<(), String> {
    // TODO: implementar quando a infraestrutura de cache estiver pronta.
    Ok(())
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// warm_hdr retorna Ok (placeholder sempre succeeds).
    #[tokio::test]
    async fn warm_hdr_placeholder_ok() {
        let result = warm_hdr(&()).await;
        assert!(result.is_ok());
    }

    /// warm_listing_generic retorna Ok (placeholder).
    #[tokio::test]
    async fn warm_listing_generic_placeholder_ok() {
        let result = warm_listing_generic("hdr", &()).await;
        assert!(result.is_ok());
    }
}
