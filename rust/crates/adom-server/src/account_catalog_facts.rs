//! Fatos vivos do catálogo, lidos e gravados no PRÓPRIO processo do gateway:
//! proteção (`adhold`/`adprot`), disponibilidade (`rdc:v2`, `davail`, `mag`),
//! prova de arquivo e índice reverso (`idx:v14`), o `adrm` da deleção e a prova
//! de arquivo da auditoria (o `PlayEffects` do play, sem reimplementação).
//!
//! Tudo aqui é SÍNCRONO (SQLite): quem chama põe em `spawn_blocking`. A chave da
//! conta fica só em memória e não aparece em log nem em resposta.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use adom_catalog::scan::{reverse_index, FileEvidence, IndexedRelease, WorkRef};
use adom_core::{ledger_key, peek_state};
use adom_debrid::alldebrid::PlayFile;
use adom_debrid::alldebrid_cleanup::{adprot_key, is_held, DurablePeek};
use adom_debrid::verdict::rd_ledger_enabled;
use adom_index::{DavailStore, MagnetState, MagnetStateStore, NativeKv, ReleaseIndexStore};
use adom_search::AudioAudit;
use serde_json::Value;

use crate::al_sweeps::effects::{NativeEffects, SweepEffects};
use crate::al_sweeps::native::open_kv;
use crate::dub_audit::now_ms;
use crate::play_effects_native::{NativePlayEffects, PlayEffects, PlayJob};

use super::port::CatalogFile;

/// Adapter único da conta do operador (`alldebrid-api.ts`).
pub(super) const ADAPTER: &str = "alldebrid";

/// Leitores e escritores do `cache.db`, abertos UMA vez por processo. Um
/// `ReleaseIndexStore::open` roda a faxina do índice, então não se abre por
/// requisição. Falha de abertura vira `None`: o fato ausente é fail-closed.
struct Readers {
    durable: DurablePeek,
    kv: Option<Arc<NativeKv>>,
    davail: Option<DavailStore>,
    mag: Option<MagnetStateStore>,
    index: Option<ReleaseIndexStore>,
}

static READERS: OnceLock<Readers> = OnceLock::new();

fn readers() -> &'static Readers {
    READERS.get_or_init(|| {
        let path = adom_store::default_cache_db_path();
        Readers {
            durable: DurablePeek::from_env(),
            kv: open_kv(),
            davail: abre("davail", DavailStore::open(&path)),
            mag: abre("mag:v1", MagnetStateStore::open(&path)),
            index: abre("idx:v14", ReleaseIndexStore::open(&path)),
        }
    })
}

fn abre<T>(nome: &str, aberto: Result<T, String>) -> Option<T> {
    match aberto {
        Ok(store) => Some(store),
        Err(err) => {
            eprintln!("[catalog] {nome} indisponível ({err}); o fato dele não é lido");
            None
        }
    }
}

/// Escritor do play (`apply_files`: `fsz` + prova de arquivo), aberto uma vez.
static PLAY: OnceLock<Arc<dyn PlayEffects>> = OnceLock::new();

fn play_effects() -> &'static Arc<dyn PlayEffects> {
    PLAY.get_or_init(|| NativePlayEffects::from_env(None))
}

/// `ENV` de `DEBRID_AUTO_FETCH_PROTECT_BR` (liga a retenção `adprot`).
fn protect_br_enabled() -> bool {
    crate::al_cleanup_facts::literal_true_env("DEBRID_AUTO_FETCH_PROTECT_BR")
}

/// Porta síncrona de fatos do catálogo. Todos os métodos podem bloquear.
pub(super) trait CatalogFacts: Send + Sync {
    /// Hold vivo, hold do processo ou retenção `adprot`. Ilegível = protegido.
    fn protected(&self, hash: &str) -> bool;
    /// `releaseStatus`: `hit`, `miss` ou `unknown`. Só leitura.
    fn release_status(&self, hash: &str) -> String;
    /// Prova de arquivo viva do hash (`fileEvidence`).
    fn file_evidence(&self, hash: &str) -> Option<FileEvidence>;
    /// Índice reverso hash → obra. `Err` = índice ilegível (a varredura não roda).
    fn reverse_index(&self) -> Result<HashMap<String, WorkRef>, String>;
    /// Listas calibradas do audit: (`ptMarkers`, `enGroups`).
    fn audio_lists(&self) -> (Vec<String>, Vec<String>);
    /// Anti-reenchimento (`adrm`) do hash apagado de propósito.
    fn on_deleted(&self, hash: &str, filename: Option<&str>);
    /// Prova de arquivo da auditoria: `fsz` e `idx:file`, pelo mesmo escritor do play.
    fn record_evidence(&self, hash: &str, files: &[CatalogFile]);
}

/// Produção: a conta do operador. `api_key` só vive aqui, em memória.
pub(super) struct ProdFacts {
    scope: String,
    api_key: String,
    audio: (Vec<String>, Vec<String>),
}

impl ProdFacts {
    pub(super) fn new(scope: String, api_key: String) -> Self {
        let audit = AudioAudit::from_env_values(
            std::env::var("AUDIO_AUDIT").ok().as_deref(),
            std::env::var("AUDIO_AUDIT_PT_MARKERS").ok().as_deref(),
            std::env::var("AUDIO_AUDIT_EN_GROUPS").ok().as_deref(),
        );
        Self {
            scope,
            api_key,
            audio: (audit.pt_markers, audit.en_groups),
        }
    }
}

impl CatalogFacts for ProdFacts {
    /// Régua de `isCleanupProtected`: hold (base durável OU processo), e a
    /// retenção `adprot` só com `DEBRID_AUTO_FETCH_PROTECT_BR` ligado. Cada
    /// leitura que falha conta como PROTEGIDA (fail-closed).
    fn protected(&self, hash: &str) -> bool {
        let r = readers();
        let now = now_ms();
        match r.durable.is_held_checked(&self.scope, hash, now) {
            None | Some(true) => return true,
            Some(false) => {}
        }
        if is_held(&self.scope, hash) {
            return true;
        }
        if protect_br_enabled() {
            return r
                .durable
                .alive_checked(&adprot_key(&self.scope, hash), now)
                .unwrap_or(true);
        }
        false
    }

    /// Porte de `releaseStatus` (`br-coverage.ts`): `blocked` do ledger vira
    /// `miss` e vence tudo; depois hit/miss do ledger, do `davail` e `alive`
    /// do magnet. Um positivo vence um negativo.
    fn release_status(&self, hash: &str) -> String {
        let r = readers();
        let now = now_ms();
        let stored = r
            .kv
            .as_ref()
            .and_then(|kv| kv.get_json(&ledger_key(hash), now).ok().flatten())
            .and_then(|value: Value| value.get("s").and_then(Value::as_str).map(str::to_string));
        let ledger = peek_state(rd_ledger_enabled(), stored.as_deref());
        match ledger {
            // Recusa legal é terminal e vence evidência local atrasada.
            "blocked" => return "miss".to_string(),
            "hit" => return "hit".to_string(),
            _ => {}
        }
        let mut has_miss = ledger == "miss";
        if let Some(davail) = &r.davail {
            match davail.get(ADAPTER, &self.api_key, hash, now) {
                Ok(Some(true)) => return "hit".to_string(),
                Ok(Some(false)) => has_miss = true,
                _ => {}
            }
        }
        if let Some(mag) = &r.mag {
            if matches!(
                mag.state(ADAPTER, &self.api_key, hash, now),
                Ok(Some(MagnetState::Alive))
            ) {
                return "hit".to_string();
            }
        }
        if has_miss {
            "miss".to_string()
        } else {
            "unknown".to_string()
        }
    }

    fn file_evidence(&self, hash: &str) -> Option<FileEvidence> {
        let index = readers().index.as_ref()?;
        index
            .file_evidence(hash, now_ms())
            .map(|ev| FileEvidence { a: ev.a, n: ev.n })
    }

    /// `snapshotAllWorks` do índice. A ordem por imdb fixa o "primeiro vence"
    /// do hash repetido, que no Node seguia a ordem do `Map`.
    fn reverse_index(&self) -> Result<HashMap<String, WorkRef>, String> {
        let index = readers()
            .index
            .as_ref()
            .ok_or_else(|| "índice idx:v14 indisponível".to_string())?;
        let works = index.snapshot_all_works(now_ms())?;
        let mut ordered: Vec<(String, Vec<IndexedRelease>)> = works
            .into_iter()
            .map(|(imdb, releases)| {
                let releases = releases
                    .into_iter()
                    .map(|rel| IndexedRelease {
                        hash: rel.hash,
                        title: rel.title,
                        is_br: rel.is_br,
                        dubbed: rel.dubbed,
                        lied: rel.lied,
                    })
                    .collect();
                (imdb, releases)
            })
            .collect();
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(reverse_index(ordered))
    }

    fn audio_lists(&self) -> (Vec<String>, Vec<String>) {
        self.audio.clone()
    }

    /// Mesmo efeito de `markReuploadBlocked`: o `NativeEffects` do sweep, com
    /// a blindagem BR, o kill-switch e o TTL dentro dele.
    fn on_deleted(&self, hash: &str, filename: Option<&str>) {
        let effects = NativeEffects::new(&self.scope, readers().kv.clone());
        effects.mark_removed(hash, filename.unwrap_or(""), now_ms());
    }

    /// `recordFileEvidence` = `apply_files` do play (fsz + prova de arquivo).
    fn record_evidence(&self, hash: &str, files: &[CatalogFile]) {
        if files.is_empty() {
            return;
        }
        let job = PlayJob {
            service: ADAPTER.to_string(),
            api_key: self.api_key.clone(),
            hash: hash.to_string(),
            imdb: String::new(),
            season: None,
            episode: None,
        };
        let list: Vec<PlayFile> = files
            .iter()
            .map(|file| PlayFile {
                path: file.path.clone(),
                size: file.size,
            })
            .collect();
        play_effects().apply_ok(job, false, false, Some(list));
    }
}
