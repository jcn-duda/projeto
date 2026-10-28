//! Portas de PRODUÇÃO das varreduras: a conta AllDebrid do operador, a
//! listagem/delete e os fatos do `cache.db`.
//!
//! Regra única: o que este módulo NÃO consegue provar vira `None`
//! (`known_before`) ou campo vazio (`uploaded_at_ms = 0`, `files` vazio,
//! `status` vazio). O plano do núcleo fecha sozinho nesses casos — nenhum fato
//! é inventado aqui.
//!
//! A lista real fornece `hash/id/status/ready/filename/uploadDate`; caminhos
//! de vídeo são lidos sob demanda por id, só para itens prontos e antigos.
//! Campos ausentes ficam vazios/zero. A escrita continua ReadOnly até o wiring
//! dos fatos de posse/supressão confirmar que todas as guardas estão completas.

use std::collections::HashSet;
use std::sync::Arc;

use adom_debrid::alldebrid::{AllDebrid, SweepMagnet};
use adom_debrid::alldebrid_cleanup::{
    account_scope, adsub_key, is_held, known_before, DurablePeek,
};
use adom_debrid::alldebrid_sweeps::{MagnetRow, SweepHttpError, SweepStop};
use adom_debrid::holds_feed::holds_feed_enabled;
use adom_debrid::http::HttpClient;
use adom_debrid::DebridError;
use adom_index::NativeKv;

use super::{DeleteFuture, FactSource, FilesFuture, RowsFuture, SweepSource};

/// Falta ligar/revisar todos os fatos de posse e supressão no gateway.
/// Não habilitar deletes só porque a listagem passou a ter metadados reais.
pub(crate) const ROW_PROOFS_COMPLETE: bool = false;

/// Conta do operador: a chave NUNCA sai daqui (sem `Debug`, sem log) e o
/// escopo é o `sha256` que casa com `adprot`/`adsub`/`adrm` e com o Node.
pub(crate) struct Account {
    key: String,
    scope: String,
}

impl Account {
    fn new(api_key: &str) -> Self {
        Self {
            key: api_key.to_string(),
            scope: account_scope(api_key),
        }
    }
}

/// `DEBRID_SERVICE`/`DEBRID_API_KEY` do operador (o mesmo `debrid_config` do
/// `/resolve`). Serviço diferente de AllDebrid ou chave vazia ⇒ `None`.
pub(crate) fn account_from_env() -> Option<Account> {
    let defaults = crate::resolve_native::defaults_from_env();
    let config = crate::resolve_native::debrid_config(None, "", &defaults).ok()?;
    if config.service != "alldebrid" || config.api_key.trim().is_empty() {
        return None;
    }
    Some(Account::new(config.api_key.trim()))
}

// ---------------------------------------------------------------------------
// Listagem e delete
// ---------------------------------------------------------------------------

pub(crate) struct NativeSource {
    ad: AllDebrid,
    key: String,
}

pub(crate) fn source(account: &Account) -> Option<Arc<dyn SweepSource>> {
    Some(Arc::new(NativeSource {
        ad: AllDebrid::new(HttpClient::new().ok()?),
        key: account.key.clone(),
    }))
}

impl SweepSource for NativeSource {
    fn rows(&self) -> RowsFuture<'_> {
        Box::pin(async move {
            match self.ad.sweep_magnet_list(&self.key).await {
                Ok(rows) => Some(rows_from(rows)),
                Err(err) => {
                    // auth/quota/rede: "não deu para saber" ≠ "conta vazia".
                    eprintln!(
                        "[al_sweeps] listagem da conta falhou ({}): rodada sem plano",
                        err.kind()
                    );
                    None
                }
            }
        })
    }

    fn files(&self, id: String) -> FilesFuture<'_> {
        Box::pin(async move {
            match self.ad.sweep_magnet_files(&self.key, &id).await {
                Ok(files) => Some(
                    files
                        .into_iter()
                        .filter(|file| is_video_path(&file.path))
                        .map(|file| file.path)
                        .collect(),
                ),
                Err(err) => {
                    eprintln!(
                        "[al_sweeps] arquivos do magnet falharam ({}): prova de áudio ausente",
                        err.kind()
                    );
                    None
                }
            }
        })
    }

    fn delete(&self, id: String) -> DeleteFuture<'_> {
        Box::pin(async move {
            self.ad
                .remove_torrent(&self.key, &id)
                .await
                .map_err(|err| http_error(&err))
        })
    }
}

fn is_video_path(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    matches!(
        extension.as_deref(),
        Some("mkv" | "mp4" | "avi" | "mov" | "m4v" | "ts" | "webm")
    )
}

/// Uma linha com SÓ os fatos reais vindos da lista da AllDebrid.
fn row(magnet: SweepMagnet) -> MagnetRow {
    let uploaded_at_ms = if magnet.upload_date_ms.is_finite()
        && magnet.upload_date_ms > 0.0
        && magnet.upload_date_ms <= i64::MAX as f64
    {
        magnet.upload_date_ms as i64
    } else {
        0
    };
    MagnetRow {
        id: magnet.id,
        hash: magnet.hash,
        name: magnet.filename,
        status: magnet.status,
        ready: magnet.ready,
        uploaded_at_ms,
        // Os caminhos são preenchidos sob demanda por `files(id)`.
        files: Vec::new(),
    }
}

/// Auth/451 param a rodada (a conta está fora); o resto é falha do id.
fn http_error(err: &DebridError) -> SweepHttpError {
    match err {
        DebridError::Auth(_) | DebridError::Blocked(_) => SweepHttpError::Terminal(SweepStop::Auth),
        DebridError::Quota(_) => SweepHttpError::Terminal(SweepStop::Quota),
        other => SweepHttpError::Failed(other.kind().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Fatos
// ---------------------------------------------------------------------------

pub(crate) struct NativeFacts {
    account: String,
    holds_on: bool,
    durable: DurablePeek,
    /// `None` = `cache.db` não abriu: sem `adsub` não há posse provada.
    kv: Option<Arc<NativeKv>>,
}

pub(crate) fn facts(account: &Account) -> Arc<dyn FactSource> {
    Arc::new(NativeFacts {
        account: account.scope.clone(),
        holds_on: holds_feed_enabled(),
        durable: DurablePeek::from_env(),
        kv: NativeKv::open(&adom_store::default_cache_db_path())
            .ok()
            .map(Arc::new),
    })
}

/// O inventário só vale como referência se o hold estiver montado: com
/// `DEBRID_AL_HOLDS` off o autofetch não publica hold e o snapshot sozinho não
/// prova que um download em voo está protegido.
pub(crate) fn gated_snapshot(
    holds_on: bool,
    snapshot: Option<HashSet<String>>,
) -> Option<HashSet<String>> {
    if holds_on {
        snapshot
    } else {
        None
    }
}

impl FactSource for NativeFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        let snapshot = known_before(&self.account).map(|set| (*set).clone());
        gated_snapshot(self.holds_on, snapshot)
    }

    fn held(&self, hash: &str) -> bool {
        is_held(&self.account, hash)
    }

    fn retained(&self, hash: &str) -> bool {
        self.durable
            .is_protected(&self.account, hash, adom_sources::now_ms())
    }

    fn owned_at(&self, hash: &str) -> Option<i64> {
        let kv = self.kv.as_ref()?;
        let key = adsub_key(&self.account, hash);
        let record = kv.get_json(&key, adom_sources::now_ms()).ok()??;
        // O Node grava `{ at }` (epoch ms). Sem `at` não há instante de posse:
        // `None` é `no_ownership` e o magnet fica.
        record.get("at").and_then(serde_json::Value::as_i64)
    }

    fn marked(&self) -> HashSet<String> {
        self.durable
            .blocked_hashes(&self.account, adom_sources::now_ms())
    }
}

/// Listagem → linhas do plano. Ordenada: o `HashMap` do adapter não tem ordem
/// e o log/diagnóstico precisa de rodada estável.
pub(crate) fn rows_from(magnets: Vec<SweepMagnet>) -> Vec<MagnetRow> {
    let mut rows: Vec<MagnetRow> = magnets.into_iter().map(row).collect();
    rows.sort_by(|a, b| a.hash.cmp(&b.hash));
    rows
}
