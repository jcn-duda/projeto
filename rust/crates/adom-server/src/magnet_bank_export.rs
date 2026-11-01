//! `GET /magnet-bank/export`: o backup do acervo vivo em NDJSON, montado pelo
//! [`MagnetBankStore::export_ndjson_into`] — o MESMO byte a byte do transfer
//! que o Node gerava em memória. A diferença é a forma: aqui o corpo sai em
//! blocos por um canal (`mpsc`) enquanto o store pagina o SQLite, então o
//! gateway não segura o acervo na RAM. As guardas são as das rotas irmãs em
//! `magnet_bank_admin` (mesma credencial destrutiva, mesmo kill-switch); a
//! rota vive em módulo próprio para o arquivo delas caber no teto.

use std::io::{self, BufWriter, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::Stream;

use adom_store::MagnetBankStore;

use crate::magnet_bank_admin::{destructive_refusal, internal, magnet_bank_enabled, refuse};
use crate::store_admin::AdminState;

/// Blocos em voo no canal: é o backpressure — o store para de paginar quando
/// o cliente não consome, em vez de acumular o acervo inteiro na RAM.
const EXPORT_CHANNEL_BOUND: usize = 16;
/// Buffer entre o store e o canal: blocos de até 64 KiB por `blocking_send`.
const EXPORT_WRITE_BUF: usize = 64 * 1024;

/// Bloco do corpo: `Err` encerra o stream com erro (o cliente vê a falha, não
/// um truncamento silencioso).
type ExportChunk = Result<Bytes, String>;

pub(crate) async fn export(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if let Some(refusal) = destructive_refusal(&state, &headers) {
        return refusal;
    }
    if !magnet_bank_enabled() {
        return refuse(StatusCode::CONFLICT, "magnet_bank_disabled");
    }
    // Abertura fora do corpo: falha aqui é 500 limpo, nunca 200 sem dados.
    let opened = tokio::task::spawn_blocking(MagnetBankStore::from_env).await;
    let store = match opened {
        Ok(Ok(store)) => store,
        Ok(Err(err)) => return internal("exportação do banco", err),
        Err(join) => return internal("exportação do banco", join.to_string()),
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ExportChunk>(EXPORT_CHANNEL_BOUND);
    tokio::task::spawn_blocking(move || match write_export(store, tx) {
        Ok(count) => eprintln!("[magnetbank] export do banco: {count} linha(s)"),
        Err(err) => eprintln!("[magnetbank] exportação do banco falhou: {err}"),
    });
    // O primeiro bloco (o cabeçalho do formato) decide o status: sem ele, o
    // cliente recebe 500 — nunca um 200 de acervo vazio fingido.
    match rx.recv().await {
        Some(Ok(first)) => (
            [(header::CONTENT_TYPE, "application/x-ndjson")],
            Body::from_stream(BodyStream {
                first: Some(Ok(first)),
                rx,
            }),
        )
            .into_response(),
        Some(Err(err)) => internal("exportação do banco", err),
        None => internal(
            "exportação do banco",
            "export não produziu o cabeçalho do formato".to_string(),
        ),
    }
}

/// Export SEM HTTP: escreve o NDJSON no `out` e devolve o número de linhas
/// escritas (o meta conta — contrato do `export_ndjson_into`). Testado direto
/// (mesma via do handler, sem socket nem env).
pub(crate) fn write_export(
    store: MagnetBankStore,
    tx: tokio::sync::mpsc::Sender<ExportChunk>,
) -> Result<u64, String> {
    let mut out = BufWriter::with_capacity(EXPORT_WRITE_BUF, BodyWriter { tx });
    let count = store.export_ndjson_into(&mut out, adom_sources::now_ms())?;
    out.flush()
        .map_err(|err| format!("descarregar export: {err}"))?;
    Ok(count)
}

/// `io::Write` sobre o canal: cada esvaziamento do BufWriter vira um bloco do
/// corpo. Falha do lado do cliente (conexão cortada) é `BrokenPipe`, que o
/// store propaga como `Err` e a task loga — sem pânico.
struct BodyWriter {
    tx: tokio::sync::mpsc::Sender<ExportChunk>,
}

impl Write for BodyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tx
            .blocking_send(Ok(Bytes::copy_from_slice(buf)))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "cliente abortou o export"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Ponte `Stream` → `Body::from_stream`: entrega o primeiro bloco guardado e
/// depois o que vier do canal.
struct BodyStream {
    first: Option<ExportChunk>,
    rx: tokio::sync::mpsc::Receiver<ExportChunk>,
}

impl Stream for BodyStream {
    type Item = ExportChunk;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        // `Receiver` é Unpin: acesso por `get_mut` é seguro e barato.
        let this = self.get_mut();
        if let Some(first) = this.first.take() {
            return Poll::Ready(Some(first));
        }
        this.rx.poll_recv(cx)
    }
}

#[cfg(test)]
#[path = "magnet_bank_export_tests.rs"]
mod tests;
