//! Freio de tráfego: consulta atividade do usuário antes de cada ciclo de crawl.
//!
//! Se o usuário está ativo (assistindo, navegando), o raspador pausa
//! para não competir por largura de banda ou sobrecarregar o Node.

use super::http_client::SidecarHttpClient;

/// Verifica se houve tráfego de usuário recente.
///
/// Chama `GET /internal/activity` no Node via [`SidecarHttpClient`].
/// Retorna `true` se o raspador deve pausar (usuário ativo).
///
/// **Fail-open**: se não consegue consultar o Node, retorna `false`
/// (assume que não há tráfego e continua o crawl). Isso evita que
/// uma falha temporária no Node paralise o raspador indefinidamente.
pub async fn recent_user_traffic(client: &SidecarHttpClient, idle_window_ms: u64) -> bool {
    match client.check_activity(idle_window_ms).await {
        Ok(recent) => recent,
        Err(e) => {
            // Loga o erro mas não bloqueia o crawl.
            eprintln!(
                "[sidecar] falha ao consultar atividade do usuário: {}; continuando",
                e
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifica que `recent_user_traffic` retorna `false` (fail-open)
    /// quando o cliente não consegue alcançar o Node.
    ///
    /// Usa um endereço que certamente recusará conexão (porta fechada).
    #[tokio::test]
    async fn recent_user_traffic_fail_open() {
        // Porta 1 raramente está em uso; a conexão será recusada.
        let client = SidecarHttpClient::new("http://127.0.0.1:1".into(), "token-fake".into());

        let should_pause = recent_user_traffic(&client, 30_000).await;
        assert!(
            !should_pause,
            "fail-open: deve retornar false quando o Node está inacessível"
        );
    }
}
