//! Resolver local dos portões e sonda da faixa Flare do executor de fundo.
//!
//! Separados do executor ([`super`]) para a fonte ficar abaixo da catraca de
//! 400 linhas do CI. O contrato do `/resolve` é o da rota do resolver local:
//! 200 com o magnet no corpo texto; pendência = 503 + `gate_pending`; erro =
//! outro status com corpo textual.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// Futuro de UM pagamento: `Ok(magnet)` ou o motivo de tentar de novo.
pub type GateFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Quem paga um portão. Trait para os testes injetarem um resolver falso —
/// nada aqui fala com o FlareSolverr real fora do [`HttpGateResolver`].
pub trait GateResolver: Send + Sync {
    fn resolve<'a>(&'a self, gate: &'a str, post: &'a str) -> GateFuture<'a>;
}

/// Resolver local real: `GET /resolve?url=<gate>&p=<post>&wait=1` na porta do
/// bludv. O `wait=1` é o modo bloqueante documentado da rota.
pub struct HttpGateResolver {
    base_url: String,
    timeout_ms: u64,
}

impl HttpGateResolver {
    pub fn new(host: &str, port: u16, timeout_ms: u64) -> Self {
        Self {
            base_url: format!("http://{host}:{port}"),
            timeout_ms,
        }
    }
}

impl GateResolver for HttpGateResolver {
    fn resolve<'a>(&'a self, gate: &'a str, post: &'a str) -> GateFuture<'a> {
        let base = self.base_url.clone();
        let timeout = Duration::from_millis(self.timeout_ms.max(1_000));
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .map_err(|e| format!("resolver: cliente: {e}"))?;
            // Query via builder: o encoding do gate/post fica com o reqwest.
            let resp = client
                .get(format!("{base}/resolve"))
                .query(&[("url", gate), ("p", post), ("wait", "1")])
                .send()
                .await
                .map_err(|e| format!("resolver: {e}"))?;
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status.as_u16() == 503 && body.contains("gate_pending") {
                // Pendência reservada da rota: o magnet ainda não está pronto
                // ("tentar de novo na próxima rodada", não é erro do site).
                return Err("pendente no resolver (cadeia em curso ou fria)".to_string());
            }
            if !status.is_success() {
                return Err(format!("resolver: http {} {body}", status.as_u16()));
            }
            let magnet = body.trim();
            // Um 200 sem magnet (HTML de erro, vazio) não vira release.
            if !magnet.starts_with("magnet:") {
                return Err("resolver: resposta sem magnet".to_string());
            }
            Ok(magnet.to_string())
        })
    }
}

/// Sonda da faixa única do solver. Implementada pelo `CrawlPageEngine`
/// (`try_lock` no `flare_gate`): ocupado = há raspagem Flare do motor em
/// curso, e o pagamento NÃO pode enfileirar atrás dela (o solver atende UM
/// pedido por vez e é o mesmo da busca ao vivo).
pub trait FlareProbe: Send + Sync {
    fn flare_busy(&self) -> bool;
}
