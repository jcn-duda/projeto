//! Rota /resolve do resolver: modo de espera e tradução de status do portão.
//!
//! Separado do `server.rs` pela catraca de 400 linhas. O contrato com o resto:
//! `server.rs` reexporta `GATE_PENDING`, `gate_wait_block_requested` e
//! `with_gate_wait_block` (consumidos por `gate_resolve.rs`), e monta esta
//! rota no router.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::future::Future;
use std::sync::Arc;

use crate::server::{ResolverCallbacks, UnwrapSeed};

/// Query params de /resolve.
#[derive(Deserialize)]
pub(crate) struct ResolveQuery {
    pub url: Option<String>,
    pub i: Option<String>,
    pub h: Option<String>,
    pub n: Option<String>,
    /// Post de contexto do portão: o executor do raspador manda o BOTÃO do
    /// gate em `url` e o post que o nomeia aqui (`p`). Com `p` e sem `i`, a
    /// rota resolve o portão direto, sem reabrir o post — cada abertura custa
    /// um pedido ao FlareSolverr, que atende um por vez.
    pub p: Option<String>,
    /// `wait=1` mantém o modo bloqueante do portão (espera a cadeia e devolve
    /// o magnet) — é o modo do raspador em fundo. Sem ele, nunca bloqueia.
    pub wait: Option<String>,
}

/// Corpo reservado da pendência do portão: o magnet ainda não está pronto e o
/// aquecimento da cadeia ficou em fundo (a busca seguinte colhe do cache).
pub const GATE_PENDING: &str = "gate_pending";

tokio::task_local! {
    /// Modo de espera do portão NA REQUISIÇÃO atual. Só o /resolve entra num
    /// scope (com false quando não há `wait=1`); /dl, prefetch em fundo e
    /// qualquer chamada fora da rota ficam fora do scope e caem no default
    /// bloqueante — o comportamento de hoje, que nada além do /resolve muda.
    /// Task-local porque o contrato do `resolve_button` é compartilhado por
    /// todas as rotas e não pode carregar parâmetro de uma rota só.
    static GATE_WAIT_BLOCK: bool;
}

/// true quando o chamador atual aceita esperar a cadeia do portão.
/// Fora de qualquer scope (ex.: /dl, prefetch em fundo) é sempre true.
pub fn gate_wait_block_requested() -> bool {
    GATE_WAIT_BLOCK.try_with(|w| *w).unwrap_or(true)
}

/// Roda o futuro com o modo de espera do portão explícito. Encapsula o
/// task-local para os testes do gate exercerem os dois modos sem HTTP.
pub fn with_gate_wait_block<F: Future + Send>(
    block: bool,
    fut: F,
) -> impl Future<Output = F::Output> + Send {
    GATE_WAIT_BLOCK.scope(block, fut)
}

/// GET /resolve?url=&i=&h=&n=[&wait=1] → magnet (text/plain 200).
///
/// url ausente ou >4096: 400 "invalid_url".
/// validateIndex (tdf/nerd): índice inválido → 502 "invalid_index".
/// Botão do portão sem magnet em cache e sem `wait=1`: 503 "gate_pending" na
/// hora, com a cadeia aquecendo em fundo. Erro: 502 com mensagem.
/// Caminho direto do portão (executor do raspador): `url=<botão do gate>&p=<post>`
/// resolve a cadeia sem reabrir o post.
///
/// PORQUÊ do 503 imediato (decisão do operador): a cadeia do anúncio leva
/// ~30s (espera mínima do anúncio) presa ao FlareSolverr, que atende UMA
/// requisição por vez; o chamador da busca desiste em ~8s, então segurar
/// aqui é prender a única vaga do solver a um chamador já morto e entupir a
/// fila do raspador. O consumidor do addon (`jackett-resolve.ts`
/// resolveDownloadMagnet) trata qualquer !ok como "sem magnet" e NUNCA grava
/// falha no cache `dlmag:` — 503 não envenena a busca seguinte: ela refaz o
/// /resolve e colhe o magnet aquecido no cache do gate. O play que cair num
/// portão frio falha na 1ª tentativa por decisão: falhar rápido custa ~1ms
/// de orçamento; esperar 30s não caberia no prazo do play e ainda ocuparia
/// o solver — o aquecimento resolve para a tentativa seguinte.
pub async fn resolve_handler(
    State(callbacks): State<Arc<dyn ResolverCallbacks>>,
    Query(params): Query<ResolveQuery>,
) -> Response {
    // Só `wait=1` exato: parâmetro documentado, sem sinônimos silenciosos —
    // quem não pediu espera, não espera.
    let wait_block = params.wait.as_deref() == Some("1");
    with_gate_wait_block(wait_block, resolve_handler_inner(callbacks, params)).await
}

/// Corpo do /resolve separado do scope: o handler só decide o modo de espera;
/// a tradução de status da pendência fica aqui.
async fn resolve_handler_inner(
    callbacks: Arc<dyn ResolverCallbacks>,
    params: ResolveQuery,
) -> Response {
    let url_value = match params.url {
        Some(u) if !u.is_empty() && u.len() <= 4096 => u,
        _ => return (StatusCode::BAD_REQUEST, "invalid_url").into_response(),
    };

    let seed = UnwrapSeed {
        index: params.i,
        hash: params.h,
        count: params.n,
    };

    let unwrapped = match callbacks.unwrap_resolver_url(&url_value, seed) {
        Ok(u) => u,
        Err(msg) => return (StatusCode::BAD_GATEWAY, msg).into_response(),
    };

    // Validação de índice (tdf/nerd): índice presente e inválido é erro explícito.
    if callbacks.validate_index() {
        if let Some(idx) = unwrapped.index {
            // Índice já vem como usize do unwrap; se o unwrap aceitou, é válido.
            // (A validação de "integer >= 0" já foi feita no unwrap.)
            let _ = idx;
        }
    }

    // Caminho direto do portão: `p` presente e sem índice — o botão e o post
    // de contexto já chegam prontos da raspagem; abrir o post de novo custaria
    // mais um pedido ao FlareSolverr (um por vez). A validação do botão
    // (hosts, path, params) é interna ao `resolve_gate`.
    let post_context = params.p.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let result = if let (Some(post), None) = (post_context, unwrapped.index) {
        callbacks.resolve_gate_direct(&unwrapped.url, post).await
    } else {
        match unwrapped.index {
            None => callbacks.resolve_best(&unwrapped.url).await,
            Some(idx) => {
                callbacks
                    .resolve_button(
                        &unwrapped.url,
                        idx,
                        unwrapped.hash.as_deref(),
                        unwrapped.count.as_deref(),
                    )
                    .await
            }
        }
    };

    match result {
        Ok(magnet) => (StatusCode::OK, magnet).into_response(),
        // Pendência do portão não é site fora do ar: 503 diz "volte em
        // instantes" (o aquecimento em fundo resolve para a próxima chamada);
        // 502 fica reservado ao erro real do site/da cadeia.
        Err(msg) if msg == GATE_PENDING => (StatusCode::SERVICE_UNAVAILABLE, msg).into_response(),
        Err(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

#[cfg(test)]
#[path = "gate_route_tests.rs"]
mod tests;
