//! Testes do adaptador e da FÁBRICA por conta: tipos espelhados → contrato do
//! crate, taxonomia do erro, resolução de `scope` no cofre a cada passo e o
//! contrato de "sem chave = SKIP".

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use adom_debrid::autofetch_ports as ports;
use adom_debrid::realdebrid_autofetch::RdAutofetchError;
use adom_debrid::torbox::TorBox;
use adom_debrid::{DebridError, HttpClient, PortError, Service};
use adom_index::NativeKv;
use adom_sources::now_ms;
use tokio::sync::mpsc;

use super::super::fakes::{batch_payload, job, FakeDebrid};
use super::super::serve::{Control, Engine, Message};
use super::super::vault::Vault;
use super::super::Policy;
use super::*;

const SEARCH: &str = "tt1234567:1:2";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

/// Builder de teste: dois serviços, dois dublês; o resto não é atendido.
fn builder_of(a: Arc<FakeDebrid>, b: Arc<FakeDebrid>) -> AdapterBuilder {
    Arc::new(
        move |service: &str, _key: &str, _scope: &str| match service {
            "alldebrid" => Some(a.clone() as DebridIo),
            "torbox" => Some(b.clone() as DebridIo),
            _ => None,
        },
    )
}

/// Todo `PortError` sai com a TAXONOMIA no prefixo e o motivo atrás: é o que o
/// painel e o log conseguem agrupar sem interpretar texto livre.
#[test]
fn erro_preserva_a_taxonomia_no_prefixo() {
    let cases = [
        (PortError::Unsupported("evict"), "unsupported:"),
        (PortError::InvalidInput("remove sem id"), "invalid_input:"),
        (PortError::Rd(RdAutofetchError::Quarantined), "quarantined:"),
        (PortError::Rd(RdAutofetchError::Cooldown), "cooldown:"),
        (
            PortError::Rd(RdAutofetchError::StoreUnavailable),
            "store_unavailable:",
        ),
        (PortError::Rd(RdAutofetchError::TaskFailed), "task_failed:"),
        (
            PortError::Debrid(DebridError::Auth("chave recusada".into())),
            "auth:",
        ),
        (
            PortError::Debrid(DebridError::RateLimit {
                message: "devagar".into(),
                retry_after_ms: Some(1_000),
            }),
            "rate_limit:",
        ),
    ];
    for (error, prefix) in cases {
        let text = error_of(error);
        assert!(
            text.starts_with(prefix),
            "faltou o prefixo {prefix}: {text}"
        );
        assert!(text.len() > prefix.len(), "motivo não pode sumir: {text}");
    }
    // A recusa do RD leva o motivo do serviço, não só o rótulo.
    assert!(error_of(PortError::Rd(RdAutofetchError::Quarantined)).contains("quarentena"));
    assert!(error_of(PortError::Rd(RdAutofetchError::Cooldown)).contains("cooldown"));
}

/// A porta REAL de um serviço: capacidade desligada vira erro explícito (nunca
/// lista vazia) e a entrada inválida não sai para a rede.
#[tokio::test]
async fn porta_real_desliga_capacidade_ausente() {
    let http = HttpClient::new().expect("cliente http");
    let service = ports::AutofetchPorts::torbox(Arc::new(TorBox::new(http)), "chave-torbox");
    let adapter = PortedDebrid::new(Arc::new(service));

    assert_eq!(adapter.service(), Service::TorBox);
    assert!(adapter.scope().starts_with("torbox:"));
    assert!(!adapter.capabilities().evict, "evict está fora nos cinco");

    let error = adapter.evict(&[]).await.unwrap_err();
    assert!(error.starts_with("unsupported:"), "{error}");
    // `remove` sem id é recusa local: nenhuma chamada de rede.
    let error = adapter.remove("").await.unwrap_err();
    assert!(error.starts_with("invalid_input:"), "{error}");
    // Nada perguntado não prova nada.
    let evidence = adapter.check(&[]).await.unwrap();
    assert!(!evidence.known);
    assert!(evidence.cached.is_empty());
}

/// Sem chave viva no cofre a fábrica devolve `None` — não inventa conta nem
/// adaptador "vazio".
#[test]
fn fabrica_devolve_none_para_escopo_sem_chave() {
    let now = now_ms();
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let built = Arc::new(Mutex::new(0usize));
    let counter = built.clone();
    let factory = factory_at(
        vault.clone(),
        Arc::new(move |_service: &str, _key: &str, _scope: &str| {
            *counter.lock().unwrap() += 1;
            Some(Arc::new(FakeDebrid::accepting()) as DebridIo)
        }),
        Arc::new(move || now),
    );

    assert!((factory)("alldebrid:conta-que-nunca-entrou").is_none());
    assert!((factory)("sem-escopo").is_none());
    assert!((factory)("").is_none());
    assert_eq!(*built.lock().unwrap(), 0, "builder não pode ser chamado");

    let scope = vault.put("alldebrid", "chave-a", now).unwrap();
    assert!((factory)(&scope).is_some());
    assert_eq!(*built.lock().unwrap(), 1);
}

/// A chave sai do COFRE no momento do uso e chega ao builder junto do serviço e
/// do escopo; nada disso vem do payload do lote.
#[test]
fn fabrica_le_a_chave_do_cofre_no_uso() {
    let now = now_ms();
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let scope = vault.put("alldebrid", "chave-do-cofre", now).unwrap();
    let seen: Arc<Mutex<Vec<(String, String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let factory = factory(vault.clone(), {
        Arc::new(move |service: &str, key: &str, scope: &str| {
            sink.lock()
                .unwrap()
                .push((service.to_string(), key.to_string(), scope.to_string()));
            Some(Arc::new(FakeDebrid::accepting()) as DebridIo)
        })
    });

    assert!((factory)(&scope).is_some());
    let calls = seen.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].0 == "alldebrid");
    assert!(calls[0].1 == "chave-do-cofre");
    assert!(calls[0].2 == scope);
}

/// Dois escopos no canal = duas contas, cada uma no seu adaptador.
#[tokio::test]
async fn lote_com_dois_escopos_usa_duas_contas() {
    let kv = kv();
    let now = now_ms();
    let vault = Arc::new(Vault::new(60_000, 8, ""));
    let scope_a = vault.put("alldebrid", "chave-a", now).unwrap();
    let scope_b = vault.put("torbox", "chave-b", now).unwrap();
    let a = Arc::new(FakeDebrid::accepting());
    let b = Arc::new(FakeDebrid::accepting());
    let factory = factory_at(
        vault.clone(),
        builder_of(a.clone(), b.clone()),
        Arc::new(move || now),
    );
    let control = Control::new(false, 60_000);
    let (tx, mut rx) = mpsc::channel(4);
    tx.try_send(Message::Batch(job(
        &scope_a,
        batch_payload("tt1:1:1", &[(&hash_of(1), true)]),
    )))
    .unwrap();
    tx.try_send(Message::Batch(job(
        &scope_b,
        batch_payload("tt2:1:1", &[(&hash_of(2), true)]),
    )))
    .unwrap();
    let engine = Engine::new(&kv, Policy::fixture(), Some(&vault), &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.jobs, 2);
    assert!(pass.errors.is_empty(), "{:?}", pass.errors);
    assert_eq!(pass.enqueued, 2);
    assert_eq!(a.accepted(), vec![hash_of(1)]);
    assert_eq!(b.accepted(), vec![hash_of(2)]);
}

/// Um adaptador que falha na checagem derruba o PRÓPRIO lote, não o da outra
/// conta: o escopo seguinte segue no canal e enfileira.
#[tokio::test]
async fn adaptador_de_uma_conta_nao_derruba_o_lote_da_outra() {
    let kv = kv();
    let now = now_ms();
    let vault = Arc::new(Vault::new(60_000, 8, ""));
    let scope_a = vault.put("alldebrid", "chave-a", now).unwrap();
    let scope_b = vault.put("torbox", "chave-b", now).unwrap();
    let mut broken = FakeDebrid::accepting();
    broken.fail_check = true;
    let a = Arc::new(broken);
    let b = Arc::new(FakeDebrid::accepting());
    let factory = factory_at(
        vault.clone(),
        builder_of(a.clone(), b.clone()),
        Arc::new(move || now),
    );
    let control = Control::new(false, 60_000);
    let (tx, mut rx) = mpsc::channel(4);
    tx.try_send(Message::Batch(job(
        &scope_a,
        batch_payload("tt1:1:1", &[(&hash_of(1), true)]),
    )))
    .unwrap();
    tx.try_send(Message::Batch(job(
        &scope_b,
        batch_payload("tt2:1:1", &[(&hash_of(2), true)]),
    )))
    .unwrap();
    let engine = Engine::new(&kv, Policy::fixture(), Some(&vault), &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.jobs, 2);
    // Só a conta quebrada entra em erro; a outra enfileira normalmente.
    assert_eq!(pass.errors.len(), 1, "{:?}", pass.errors);
    assert_eq!(pass.enqueued, 1);
    assert!(a.accepted().is_empty());
    assert_eq!(b.accepted(), vec![hash_of(2)]);
}

/// O cofre vence no MEIO do lote: o passo seguinte é PULADO com o motivo
/// `no-credential` — não é erro, não é recusa do serviço e o lote anterior fica
/// intacto.
#[tokio::test]
async fn cofre_expira_no_meio_do_lote_e_o_passo_seguinte_e_pulado() {
    let kv = kv();
    let clock = Arc::new(AtomicI64::new(0));
    let now = clock.clone();
    let vault = Arc::new(Vault::new(1_000, 4, ""));
    let scope = vault.put("alldebrid", "chave-curta", 0).unwrap();
    let fake = Arc::new(FakeDebrid::accepting());
    let factory = factory_at(
        vault.clone(),
        builder_of(fake.clone(), Arc::new(FakeDebrid::accepting())),
        Arc::new(move || now.load(Ordering::Relaxed)),
    );
    let control = Control::new(false, 60_000);
    let (tx, mut rx) = mpsc::channel(4);
    tx.try_send(Message::Batch(job(
        &scope,
        batch_payload(SEARCH, &[(&hash_of(1), true)]),
    )))
    .unwrap();
    let engine = Engine::new(&kv, Policy::fixture(), Some(&vault), &factory, &control);

    // Passagem com a chave viva: enfileira de verdade.
    let first = engine.run_once(&mut rx, 0).await;
    assert_eq!(first.enqueued, 1);
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(fake.accepted(), vec![hash_of(1)]);
    assert!(vault.key(&scope, 0).is_some());

    // O cofre vence (TTL 1s) e a passagem seguinte não pode quebrar.
    clock.store(5_000, Ordering::Relaxed);
    tx.try_send(Message::Batch(job(
        &scope,
        batch_payload("tt7654321:1:2", &[(&hash_of(2), true)]),
    )))
    .unwrap();
    let second = engine.run_once(&mut rx, 5_000).await;
    assert_eq!(second.jobs, 1);
    assert!(second.errors.is_empty(), "{:?}", second.errors);
    assert_eq!(second.skips.get("no-credential"), Some(&1));
    assert_eq!(second.enqueued, 0);
    // Nada novo foi aceito; o lote anterior continua armado.
    assert_eq!(fake.accepted(), vec![hash_of(1)]);
    assert!(super::super::recheck::read(&kv, SEARCH, 5_000)
        .unwrap()
        .is_some());
}
