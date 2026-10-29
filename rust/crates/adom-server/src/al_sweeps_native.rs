//! Portas de PRODUÇÃO das varreduras: a conta AllDebrid do operador, a
//! listagem/delete e os fatos do `cache.db`.
//!
//! Regra única: o que este módulo NÃO consegue provar vira `None`
//! (`known_before`) ou campo vazio (`uploaded_at_ms = 0`, `files` vazio,
//! `status` vazio). O plano do núcleo fecha sozinho nesses casos — nenhum fato
//! é inventado aqui. Os EFEITOS de estado (adrm/poda/cura) são de
//! `al_sweeps_effects`; o freio de aplicação é o gate `DEBRID_AL_SWEEP_APPLY`
//! (default OFF, lido em `al_sweeps_env`), não este módulo.

use std::collections::HashSet;
use std::sync::Arc;

use adom_autofetch::v3::SuppressedV3;
use adom_debrid::alldebrid::{AllDebrid, SweepMagnet};
use adom_debrid::alldebrid_cleanup::{
    account_scope, inventory, is_held, known_before, DurablePeek,
};
use adom_debrid::alldebrid_sweeps::{MagnetRow, SweepHttpError, SweepStop};
use adom_debrid::holds_feed::holds_feed_enabled;
use adom_debrid::http::HttpClient;
use adom_debrid::DebridError;
use adom_index::NativeKv;

use super::{DeleteFuture, FactSource, FilesFuture, RowsFuture, SweepSource};

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
    /// `None` = `cache.db` não abriu: sem `adsub` não há posse provada e a
    /// fila `sup:` lê vazia (fail-closed: sem fato, o plano não condena).
    kv: Option<Arc<NativeKv>>,
}

/// Um SÓ handle do `cache.db` para os fatos e para os efeitos da rodada.
pub(crate) fn open_kv() -> Option<Arc<NativeKv>> {
    NativeKv::open(&adom_store::default_cache_db_path())
        .ok()
        .map(Arc::new)
}

pub(crate) fn facts_with_kv(account: &Account, kv: Option<Arc<NativeKv>>) -> Arc<dyn FactSource> {
    Arc::new(NativeFacts {
        account: account.scope.clone(),
        holds_on: holds_feed_enabled(),
        durable: DurablePeek::from_env(),
        kv,
    })
}

/// Efeitos de produção (adrm/poda/cura) sobre o MESMO handle do `cache.db`.
/// O escopo vem da conta: é o que casa com `adprot`/`adsub`/`adrm` do Node.
pub(crate) fn effects(
    account: &Account,
    kv: Option<Arc<NativeKv>>,
) -> Arc<dyn super::effects::SweepEffects> {
    Arc::new(super::effects::NativeEffects::new(&account.scope, kv))
}

/// Carregador do inventário frio. A rodada que acorda sem snapshot faz UMA
/// chamada aguardada de `/magnet/status` (caminho de fundo; a busca quente
/// nunca espera isto). O snapshot sai pela MESMA régua do Node
/// (`build_snapshot`): conta − posse durável (`adsub`, com o kill-switch) −
/// `submitted` desta instância. Falhou ⇒ `None`: a rodada inteira fecha em
/// `inventory_missing` e fica RELATADA — nada é inventado para destravar.
pub(crate) struct NativeInventory {
    ad: AllDebrid,
    key: String,
    account: String,
    durable: DurablePeek,
}

impl super::InventoryEnsure for NativeInventory {
    fn ensure(&self) -> super::EnsureFuture<'_> {
        Box::pin(async move {
            // Peek barato primeiro: snapshot vivo não dispara rede.
            if known_before(&self.account).is_some() {
                return;
            }
            // `load_now` respeita o lease do refresh: não disputa com o
            // refresh em fundo que a busca quente pode ter disparado.
            if inventory()
                .load_now(&self.ad, &self.key, &self.account, Some(&self.durable))
                .await
                .is_none()
            {
                eprintln!(
                    "[al_sweeps] inventário frio sem carga: rodada segue fail-closed (inventory_missing)"
                );
            }
        })
    }
}

/// Porta de produção do [`super::InventoryEnsure`]. `None` = sem cliente HTTP.
pub(crate) fn inventory_ensure(account: &Account) -> Option<Arc<dyn super::InventoryEnsure>> {
    Some(Arc::new(NativeInventory {
        ad: AllDebrid::new(HttpClient::new().ok()?),
        key: account.key.clone(),
        account: account.scope.clone(),
        durable: DurablePeek::from_env(),
    }))
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

impl NativeFacts {
    /// Hold em DUAS camadas, o mesmo OR da evicção (`autofetch_ports_evict.rs`):
    /// o mapa em processo E o `adhold:v1` do KV (o que o Node/worker gravou com
    /// TTL). Sem o KV, um hold do Node seria invisível para a varredura — e a
    /// poda o ignoraria. COM prova: `None` = base durável ilegível, e ausência
    /// de hold não lida não é veredito (fail-closed).
    fn hold_verdict(&self, hash: &str, now: i64) -> Option<bool> {
        let durable_held = self.durable.is_held_checked(&self.account, hash, now)?;
        Some(is_held(&self.account, hash) || durable_held)
    }
}

impl FactSource for NativeFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        let snapshot = known_before(&self.account).map(|set| (*set).clone());
        gated_snapshot(self.holds_on, snapshot)
    }

    /// A fonte durável (`adprot`/`adhold` no `cache.db`) LEGÍVEL é
    /// pré-condição de plano: sem leitura, "não protegido" não é provável.
    fn durable_readable(&self) -> bool {
        self.durable.readable()
    }

    fn held(&self, hash: &str) -> bool {
        self.hold_verdict(hash, adom_sources::now_ms())
            .unwrap_or(false)
    }

    /// Hold COM prova de leitura: `None` = `cache.db` ilegível agora (a poda
    /// mantém o registro em vez de tratá-lo como "sem hold").
    fn held_checked(&self, hash: &str) -> Option<bool> {
        self.hold_verdict(hash, adom_sources::now_ms())
    }

    fn retained(&self, hash: &str) -> bool {
        self.durable
            .is_protected(&self.account, hash, adom_sources::now_ms())
    }

    fn owned_at(&self, hash: &str) -> Option<i64> {
        // Obrigatoriamente via `DurablePeek`: o kill-switch da posse
        // (`ALLDEBRID_SUBMITTED_TTL_MS <= 0`) desliga a prova NA ORIGEM (a
        // mesma régua de `hasDurableOwnership` do Node). Ler `adsub` direto do
        // KV por presença condenaria no reconcile/revalidate um hash que o
        // Node nem considera nosso.
        self.durable
            .owned_at(&self.account, hash, adom_sources::now_ms())
    }

    fn marked(&self) -> HashSet<String> {
        self.durable
            .blocked_hashes(&self.account, adom_sources::now_ms())
    }

    /// Fila `sup:` da conta (fase 1 do wiring): a MESMA represa que o passo
    /// nativo do recheck escreve. Banco indisponível lê vazio — o revalidate
    /// não condena ninguém por omissão de fato.
    fn suppressed(&self) -> HashSet<String> {
        let Some(kv) = self.kv.as_ref() else {
            return HashSet::new();
        };
        let now = adom_sources::now_ms();
        match SuppressedV3::new(kv).list(SWEEPS_ADAPTER, &self.account, now, false) {
            Ok(fila) => fila.into_iter().map(|(hash, _)| hash).collect(),
            Err(err) => {
                eprintln!("[al_sweeps] fila sup: ilegível ({err}): revalidate sem fila");
                HashSet::new()
            }
        }
    }
}

/// Adapter único da fila `sup:` (`id` de `alldebrid-api.ts`).
const SWEEPS_ADAPTER: &str = "alldebrid";

/// Construtor de teste: o wiring real (`facts_with_kv`) lê env; aqui a conta
/// e o `DurablePeek` entram prontos (o teste do kill-switch da posse não
/// depende de `CACHE_DB_PATH`).
#[cfg(test)]
pub(crate) fn facts_for_test(
    account: &str,
    kv: Option<Arc<NativeKv>>,
    durable: DurablePeek,
) -> NativeFacts {
    NativeFacts {
        account: account.to_string(),
        holds_on: true,
        durable,
        kv,
    }
}

#[cfg(test)]
#[path = "al_sweeps_native_tests.rs"]
mod native_tests;

/// Listagem → linhas do plano. Ordenada: o `HashMap` do adapter não tem ordem
/// e o log/diagnóstico precisa de rodada estável.
pub(crate) fn rows_from(magnets: Vec<SweepMagnet>) -> Vec<MagnetRow> {
    let mut rows: Vec<MagnetRow> = magnets.into_iter().map(row).collect();
    rows.sort_by(|a, b| a.hash.cmp(&b.hash));
    rows
}
