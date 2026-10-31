//! Porta de I/O da conta do operador para o catálogo: listagem, árvore de
//! arquivos, deleção e inventário (`knownBefore`). Produção = AllDebrid do
//! processo; os testes usam um fake que implementa o mesmo trait, sem rede.
//!
//! Erro de listagem é `Err` e NUNCA vira lista vazia: quem recebe `Err` não
//! varre (senão o catálogo tombstonaria a conta inteira).

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use adom_catalog::dedup::{DeleteFailure, DeleteResponse};
use adom_catalog::scan::Magnet;
use adom_debrid::alldebrid::{AllDebrid, SizedMagnet};
use adom_debrid::alldebrid_cleanup::{inventory, known_before, DurablePeek};
use adom_debrid::alldebrid_delete::{delete_with_backoff, DeleteConfig};

use crate::al_sweeps::native::gated_snapshot;
use adom_debrid::holds_feed::holds_feed_enabled;

/// Future devolvida pela porta. `Send` para o handler do axum poder aguardá-la.
pub(crate) type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// Arquivo de um magnet pronto (caminho e tamanho, como o `DebridFile` do TS).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CatalogFile {
    pub path: String,
    pub size: f64,
}

pub(crate) trait AccountCatalogPort: Send + Sync {
    /// Listagem completa da conta. `Err` = a leitura não aconteceu.
    fn list(&self) -> PortFuture<'_, Vec<Magnet>>;
    /// Árvore de arquivos de UM magnet (vazia quando não está pronto).
    fn files(&self, service_id: String) -> PortFuture<'_, Vec<CatalogFile>>;
    /// Deleção dos ids pedidos (o catálogo chama um id por vez).
    fn delete(&self, ids: Vec<String>) -> PortFuture<'_, DeleteResponse>;
    /// Acervo que JÁ ERA da conta. `None` = sem referência (fail-closed).
    fn known_before(&self) -> PortFuture<'_, Option<HashSet<String>>>;
}

/// Produção: a conta AllDebrid do operador. A chave só vive aqui, em memória.
pub(crate) struct AllDebridPort {
    ad: AllDebrid,
    key: String,
    scope: String,
    durable: DurablePeek,
}

impl AllDebridPort {
    pub(crate) fn new(ad: AllDebrid, key: String, scope: String) -> Self {
        Self {
            ad,
            key,
            scope,
            durable: DurablePeek::from_env(),
        }
    }
}

/// Tamanho do `SizedMagnet` como inteiro (`Number(size) || 0` do TS). NaN e
/// infinito viram 0 pelo cast saturante do Rust.
fn size_i64(value: f64) -> i64 {
    if value.is_finite() {
        value.trunc() as i64
    } else {
        0
    }
}

/// Linha da porta no formato do catálogo. `uploadDate` já vem em ms (×1000).
fn to_magnet(row: SizedMagnet) -> Magnet {
    Magnet {
        id: Some(row.magnet.id),
        hash: row.magnet.hash,
        filename: row.magnet.filename,
        size: size_i64(row.size),
        status: row.magnet.status,
        ready: row.magnet.ready,
        upload_date: size_i64(row.magnet.upload_date_ms),
    }
}

impl AccountCatalogPort for AllDebridPort {
    fn list(&self) -> PortFuture<'_, Vec<Magnet>> {
        Box::pin(async move {
            let rows = self
                .ad
                .sized_magnet_list(&self.key)
                .await
                .map_err(|err| err.kind().to_string())?;
            Ok(rows.into_iter().map(to_magnet).collect())
        })
    }

    fn files(&self, service_id: String) -> PortFuture<'_, Vec<CatalogFile>> {
        Box::pin(async move {
            let files = self
                .ad
                .sweep_magnet_files(&self.key, &service_id)
                .await
                .map_err(|err| err.kind().to_string())?;
            Ok(files
                .into_iter()
                .map(|file| CatalogFile {
                    path: file.path,
                    size: file.size,
                })
                .collect())
        })
    }

    fn delete(&self, ids: Vec<String>) -> PortFuture<'_, DeleteResponse> {
        Box::pin(async move {
            let report =
                delete_with_backoff(&self.ad, &self.key, &ids, DeleteConfig::from_env()).await;
            // Cada id que não saiu vira uma falha; o motivo de parada (quota,
            // auth, kill-switch) entra na mensagem para o operador.
            let reason = report
                .stopped
                .map_or("delete_failed", |stop| stop.as_str())
                .to_string();
            let falhas = report
                .failed
                .iter()
                .map(|_| DeleteFailure {
                    message: Some(reason.clone()),
                })
                .collect();
            Ok(DeleteResponse {
                ok: report.removed.len() as i64,
                falhas,
                removed_ids: Some(report.removed),
            })
        })
    }

    /// Mesma régua de `NativeInventory::ensure` + `known_before` das varreduras:
    /// peek primeiro, uma carga aguardada se frio, e o portão dos holds.
    fn known_before(&self) -> PortFuture<'_, Option<HashSet<String>>> {
        Box::pin(async move {
            if known_before(&self.scope).is_none() {
                let _ = inventory()
                    .load_now(&self.ad, &self.key, &self.scope, Some(&self.durable))
                    .await;
            }
            let snapshot = known_before(&self.scope).map(|set| (*set).clone());
            Ok(gated_snapshot(holds_feed_enabled(), snapshot))
        })
    }
}
