//! Segunda parte: Real-Debrid (posse/ledger), conta e capacidades desligadas.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::rd_gate_executor::RdGateExecutor;
use crate::rd_scheduler::RdSchedulerConfig;
use crate::realdebrid::RealDebrid;
use crate::realdebrid_autofetch::{RdUncertainIntent, RdUncertainStore};

const RD_KEY: &str = "rd-port-key";
const RD_HASH: &str = "0123456789abcdef0123456789abcdef01234567";

/// Store de intent do chamador. `owns` é a prova de posse que o RD exige.
#[derive(Default)]
pub(super) struct StoreSpy {
    pub(super) owns: bool,
    pub(super) intents: Mutex<HashSet<String>>,
}

impl RdUncertainStore for StoreSpy {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        Ok(self.intents.lock().unwrap().contains(key))
    }

    fn put_intent_if_absent(&self, key: &str, _intent: &RdUncertainIntent) -> Result<bool, String> {
        Ok(self.intents.lock().unwrap().insert(key.to_string()))
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        self.intents.lock().unwrap().remove(key);
        Ok(())
    }

    fn owns_transfer(&self, _account: &str, _hash: &str, _id: &str) -> Result<bool, String> {
        Ok(self.owns)
    }
}

/// Gate do teste: sem gap entre escritas (`min_gap_ms: 0`), como no teste do
/// primitivo. Em produção o executor vem do play nativo.
pub(super) fn gate() -> RdGateExecutor {
    RdGateExecutor::new(RdSchedulerConfig {
        min_gap_ms: 0.0,
        max_gap_ms: 0.0,
        cooldown_ms: 100.0,
        play_max_wait_ms: 0.0,
        success_threshold: 2,
        enabled: true,
    })
}

pub(super) fn realdebrid(addr: SocketAddr) -> Arc<RealDebrid> {
    Arc::new(with_env("REALDEBRID_API_BASE", &base(addr), || {
        RealDebrid::new(HttpClient::new().unwrap())
    }))
}

#[tokio::test]
async fn remove_realdebrid_sem_posse_nao_escreve() {
    let (addr, scene) = listen(
        vec![("GET /torrents", 200, "[]".into())],
        (404, "{}".into()),
    )
    .await;
    let store = Arc::new(StoreSpy::default());
    let port = AutofetchPorts::realdebrid(RdPorts::new(realdebrid(addr), gate(), store), RD_KEY);
    let mut ids = BTreeMap::new();
    ids.insert(RD_HASH.to_string(), "42".to_string());
    // O `status` é quem ensina o par id→hash à porta.
    let status = port.status(&[RD_HASH.to_string()], &ids).await.unwrap();
    assert_eq!(status[RD_HASH].state, "unknown");
    assert_eq!(status[RD_HASH].transfer_id.as_deref(), Some("42"));
    assert!(!port.remove("42").await.unwrap(), "posse de outro transfer");
    assert_eq!(hits(&scene), 1, "só o GET /torrents do status");
}

#[tokio::test]
async fn remove_realdebrid_com_posse_apaga_uma_vez() {
    let (addr, scene) = listen(
        vec![
            ("GET /torrents", 200, "[]".into()),
            ("DELETE /torrents/delete/42", 204, String::new()),
        ],
        (404, "{}".into()),
    )
    .await;
    let store = Arc::new(StoreSpy {
        owns: true,
        ..StoreSpy::default()
    });
    let port = AutofetchPorts::realdebrid(RdPorts::new(realdebrid(addr), gate(), store), RD_KEY);
    let mut ids = BTreeMap::new();
    ids.insert(RD_HASH.to_string(), "42".to_string());
    port.status(&[RD_HASH.to_string()], &ids).await.unwrap();
    assert!(port.remove("42").await.unwrap());
    let paths: Vec<String> = scene
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|hit| hit.path.clone())
        .collect();
    assert_eq!(paths, ["/torrents", "/torrents/delete/42"]);
}

#[tokio::test]
async fn remove_realdebrid_de_id_desconhecido_nao_inventa_hash() {
    let (addr, scene) = listen(vec![], (404, "{}".into())).await;
    let store = Arc::new(StoreSpy {
        owns: true,
        ..StoreSpy::default()
    });
    let port = AutofetchPorts::realdebrid(RdPorts::new(realdebrid(addr), gate(), store), RD_KEY);
    // Sem `status` prévio a porta não conhece o hash: nada é escrito.
    assert!(!port.remove("42").await.unwrap());
    assert_eq!(hits(&scene), 0);
}

#[tokio::test]
async fn check_realdebrid_sem_ledger_e_desconhecido() {
    let (addr, scene) = listen(vec![], (404, "{}".into())).await;
    let port = AutofetchPorts::realdebrid(
        RdPorts::new(realdebrid(addr), gate(), Arc::new(StoreSpy::default())),
        RD_KEY,
    );
    let evidence = port.check(&[RD_HASH.to_string()]).await.unwrap();
    assert!(!evidence.known, "sem probe do ledger não há prova de cache");
    assert!(evidence.cached.is_empty());
    assert_eq!(hits(&scene), 0);
    assert!(!port.capabilities().cache_known);
}

#[tokio::test]
async fn check_realdebrid_com_ledger_prova_hit_sem_rede() {
    let (addr, scene) = listen(vec![], (404, "{}".into())).await;
    let peek: RdLedgerPeek = Arc::new(|hash: &str| Some(hash == RD_HASH));
    let ports =
        RdPorts::new(realdebrid(addr), gate(), Arc::new(StoreSpy::default())).with_ledger(peek);
    let port = AutofetchPorts::realdebrid(ports, RD_KEY);
    let evidence = port
        .check(&[RD_HASH.to_string(), hash_of('b')])
        .await
        .unwrap();
    assert!(evidence.known);
    assert_eq!(evidence.cached, vec![RD_HASH.to_string()]);
    assert_eq!(hits(&scene), 0, "peek do ledger é puro");
    assert!(port.capabilities().cache_known);
}

#[tokio::test]
async fn conta_premiumize_com_quota_esgotada_vira_limite_cheio() {
    let body = json!({"status": "success", "limit_used": 1.0}).to_string();
    let (addr, _scene) = listen(vec![("GET /account/info", 200, body)], (404, "{}".into())).await;
    let port = AutofetchPorts::premiumize(premiumize(addr), KEY);
    let account = port.account().await.unwrap();
    assert_eq!(account.used, Some(1000));
    assert_eq!(account.max, Some(1000));
}

#[tokio::test]
async fn conta_alldebrid_publica_ocupacao_sem_inventar_teto() {
    let body = envelope(json!({"magnets": [
        {"id": 1, "hash": hash_of('a'), "status": "Ready"},
        {"id": 2, "hash": hash_of('b'), "status": "Downloading"},
    ]}));
    let (addr, _scene) = listen(vec![("GET /magnet/status", 200, body)], (404, "{}".into())).await;
    let port = AutofetchPorts::alldebrid(alldebrid(addr), KEY, AlldebridFacts::default());
    let account = port.account().await.unwrap();
    assert_eq!(account.used, Some(2));
    assert_eq!(account.max, None, "teto medido não é teto publicado");
}

#[tokio::test]
async fn debridlink_desliga_evict_account_e_prova_de_cache() {
    // Sem mock e sem env de propósito: `debridlink_tests` serializa a base com
    // trava PRÓPRIA (não a `test_env`), então mexer em `DEBRIDLINK_API_BASE`
    // aqui seria corrida com ele. As três operações abaixo não fazem I/O — é
    // justamente isso que o teste prova.
    let port =
        AutofetchPorts::debridlink(Arc::new(DebridLink::new(HttpClient::new().unwrap())), KEY);
    assert_eq!(
        port.evict(&[hash_of('a')]).await.unwrap_err().kind(),
        "unsupported"
    );
    assert_eq!(port.account().await.unwrap_err().kind(), "unsupported");
    let evidence = port.check(&[hash_of('a')]).await.unwrap();
    assert!(
        !evidence.known,
        "CACHE_CHECK=false não vira 'nada em cache'"
    );
    assert!(evidence.cached.is_empty());
    let capabilities = port.capabilities();
    assert!(!capabilities.evict);
    assert!(!capabilities.account);
    assert!(!capabilities.cache_known);
}

#[tokio::test]
async fn escopo_da_porta_nao_carrega_a_chave() {
    let (addr, _scene) = listen(vec![], (404, "{}".into())).await;
    let port = AutofetchPorts::torbox(torbox(addr), KEY);
    assert_eq!(port.service(), Service::TorBox);
    assert!(port.scope().starts_with("torbox:"));
    assert!(!port.scope().contains(KEY));
    assert!(!port.capabilities().evict);
}
