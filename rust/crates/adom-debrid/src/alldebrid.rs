//! Fundação HTTP do AllDebrid: leitura da conta e play.
//!
//! A checagem de cache é um `/magnet/upload` real — largar a espera não
//! cancela o GET (`abort_safe`). Inventário ausente não apaga ninguém.
//! Fora: varredura, reconcile, reupload, evict, autofetch, inventário
//! sqlite e hold persistente. Sem log de chave, magnet ou corpo.

use std::time::Duration;

use adom_core::{may_delete, pick_file, DeleteFacts, PickOutcome, PlayHint};
use reqwest::Method;
use serde_json::Value;

use crate::error::DebridError;
use crate::http::{Call, HttpClient};

#[path = "alldebrid_check.rs"]
mod check;

#[path = "alldebrid_parse.rs"]
mod parse;
use parse::{
    as_debrid, first_magnet, flatten, leaf_link, magnet_id, nonempty, pick_error, status_pending,
    status_ready, summarize, unwrap_payload,
};

#[cfg(test)]
#[path = "alldebrid_tests.rs"]
mod alldebrid_tests;

#[cfg(test)]
#[path = "alldebrid_play_tests.rs"]
mod alldebrid_play_tests;

pub use check::{CacheReport, CheckOpts};

/// O `ready` do upload substitui o `/magnet/instant`, que a AllDebrid tirou.
pub const CACHE_CHECK: bool = true;
const _: () = assert!(CACHE_CHECK);
/// Igual ao TS: a consulta cria transferência e o prazo da busca não a aborta.
pub const ABORT_SAFE_CACHE_CHECK: bool = false;
const _: () = assert!(!ABORT_SAFE_CACHE_CHECK);

const DEFAULT_BASE: &str = "https://api.alldebrid.com/v4.1";
const AGENT: &str = "stremio-adom";
const CALL_TIMEOUT: Duration = Duration::from_millis(6_000);
pub(super) const CHECK_TIMEOUT: Duration = Duration::from_millis(10_000);
pub(super) const DEFAULT_BATCH: usize = 25;
const MAX_STATUS_WAITS: u32 = 3;

pub struct AllDebrid {
    client: HttpClient,
    base: String,
}

/// `poll_wait` no lugar dos 700 ms. `held` é o veto do autofetch neste play.
#[derive(Debug, Clone, Copy)]
pub struct ResolveOpts {
    pub poll_wait: Duration,
    pub drop_uncached: bool,
    pub held: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountStatus {
    pub magnets: usize,
    pub ready: usize,
    pub active: usize,
    pub error: usize,
    /// Menor `uploadDate` da API (segundos), ou nenhum.
    pub oldest_at: Option<i64>,
}

struct Leaf {
    path: String,
    size: f64,
    link: String,
}

impl AllDebrid {
    /// Base recusada fica vazia: a chamada erra sem pedir nada à rede.
    pub fn new(client: HttpClient) -> Self {
        let base = match std::env::var("ALLDEBRID_API_BASE") {
            Ok(raw) if !raw.trim().is_empty() => check::accepted_base(&raw).unwrap_or_default(),
            _ => DEFAULT_BASE.to_string(),
        };
        Self { client, base }
    }

    pub async fn check_cached(
        &self,
        api_key: &str,
        hashes: &[String],
        opts: &CheckOpts,
    ) -> Result<CacheReport, DebridError> {
        self.usable_base()?;
        check::check_cached(self, api_key, hashes, opts).await
    }

    /// GET `/magnet/status`. `ready` ou status Ready; ativo é a lista fixa.
    pub async fn account_status(&self, api_key: &str) -> Result<AccountStatus, DebridError> {
        let data = self
            .call(api_key, "/magnet/status", &[], CALL_TIMEOUT, false)
            .await?;
        Ok(summarize(&data))
    }

    /// Upload, no máximo 3 esperas, `/link/unlock` do arquivo escolhido.
    pub async fn resolve_link(
        &self,
        api_key: &str,
        info_hash: &str,
        hint: &PlayHint,
        opts: &ResolveOpts,
    ) -> Result<Option<String>, DebridError> {
        self.usable_base()?;
        let uploaded = self
            .call(
                api_key,
                "/magnet/upload",
                &[("magnets[]", info_hash)],
                CALL_TIMEOUT,
                true,
            )
            .await?;
        let Some(id) = first_magnet(&uploaded).and_then(magnet_id) else {
            return Ok(None);
        };
        let mut info = self.magnet_status(api_key, &id).await?;
        let mut waits = 0;
        while waits < MAX_STATUS_WAITS && status_pending(&info) {
            tokio::time::sleep(opts.poll_wait).await;
            waits += 1;
            info = self.magnet_status(api_key, &id).await?;
        }
        let Some(magnet) = info else {
            self.delete_cold(api_key, &id, opts).await?;
            return Ok(None);
        };
        if !status_ready(&magnet) {
            self.delete_cold(api_key, &id, opts).await?;
            return Ok(None);
        }
        self.unlock_picked(api_key, &magnet, hint).await
    }

    fn usable_base(&self) -> Result<&str, DebridError> {
        if self.base.is_empty() {
            Err(check::base_rejected())
        } else {
            Ok(&self.base)
        }
    }

    /// O `call` do TS não passa method: tudo aqui é GET, com `agent` na query.
    pub(super) async fn call(
        &self,
        api_key: &str,
        path: &str,
        params: &[(&str, &str)],
        timeout: Duration,
        abort_safe: bool,
    ) -> Result<Value, DebridError> {
        let url = check::query_url(self.usable_base()?, path, params);
        let data = self
            .client
            .json(Call {
                method: Method::GET,
                url,
                headers: vec![("Authorization".into(), format!("Bearer {api_key}"))],
                body: None,
                timeout,
                abort_safe,
            })
            .await?;
        let Some(data) = data else {
            return Err(DebridError::other("alldebrid retornou erro"));
        };
        unwrap_payload(data)
    }

    /// Fonte: `deleteMagnetsNow` chama `call(apiKey, '/magnet/delete', { id })`.
    /// Sem method no `call`, é GET e o id vai na query. A fila (4 workers,
    /// backoff e segunda rodada) ficou de fora: um único GET, `id` repetido
    /// como o `searchParams.append` faria com um array. Falha devolve o erro
    /// e não há segunda tentativa.
    pub(super) async fn delete_ids(
        &self,
        api_key: &str,
        ids: &[String],
    ) -> Result<(), DebridError> {
        if ids.is_empty() {
            return Ok(());
        }
        let params: Vec<(&str, &str)> = ids.iter().map(|id| ("id", id.as_str())).collect();
        self.call(api_key, "/magnet/delete", &params, CALL_TIMEOUT, false)
            .await?;
        Ok(())
    }

    async fn magnet_status(&self, api_key: &str, id: &str) -> Result<Option<Value>, DebridError> {
        let data = self
            .call(
                api_key,
                "/magnet/status",
                &[("id", id)],
                CALL_TIMEOUT,
                false,
            )
            .await?;
        Ok(first_magnet(&data).cloned())
    }

    /// O play passa `inventoryLoaded: true` e `knownBefore: false`. Hold é argumento.
    async fn delete_cold(
        &self,
        api_key: &str,
        id: &str,
        opts: &ResolveOpts,
    ) -> Result<(), DebridError> {
        let allowed = may_delete(DeleteFacts {
            inventory_loaded: true,
            known_before: false,
            protected: opts.held,
        });
        if opts.drop_uncached && allowed {
            let ids = [id.to_string()];
            self.delete_ids(api_key, &ids).await?;
        }
        Ok(())
    }

    async fn unlock_picked(
        &self,
        api_key: &str,
        magnet: &Value,
        hint: &PlayHint,
    ) -> Result<Option<String>, DebridError> {
        let mut leaves = Vec::new();
        if let Some(files) = magnet.get("files").and_then(Value::as_array) {
            flatten(files, "", &mut leaves);
        }
        let picked = pick_file(&as_debrid(&leaves), hint);
        match picked {
            PickOutcome::Empty => Ok(None),
            PickOutcome::Error { code, .. } => Err(pick_error(code)),
            PickOutcome::File { path, size } => {
                let Some(link) = leaf_link(&leaves, &path, size) else {
                    return Ok(None);
                };
                let unlocked = self
                    .call(
                        api_key,
                        "/link/unlock",
                        &[("link", &link)],
                        CALL_TIMEOUT,
                        false,
                    )
                    .await?;
                Ok(nonempty(unlocked.get("link")))
            }
        }
    }
}
