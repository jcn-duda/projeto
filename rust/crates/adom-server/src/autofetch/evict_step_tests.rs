//! Passo de evicção: fail-closed do delete, kill-switch, teto e parada.
//!
//! Nenhum teste toca a rede nem a env do processo: as réguas entram como
//! [`EvictGates`] e o debrid como [`StubIo`] (fila roteirizada de `remove`).

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use adom_autofetch::v3::evict::{EvictReport, EvictSkip, EvictStop};
use adom_autofetch::v3::{
    AccountEvidence, AutofetchDebrid, CacheEvidence, DebridFuture, EnqueueEvidence, EvictOutcome,
    QueueCandidate, TorrentEvidence,
};

use super::{plan, plan_hashes, run, EvictAction, EvictFacts, EvictGates, EvictItem, Occupancy};

const NOW: i64 = 1_700_000_000_000;
const MIN_AGE: i64 = 1_800_000;

/// Item elegível por padrão: `any`, marker da obra, posse, 1 h de idade.
fn item(hash: &str) -> EvictItem {
    EvictItem {
        hash: hash.into(),
        transfer_id: Some(format!("id-{hash}")),
        name: Some(format!("Fallback.{hash}.1080p.mkv")),
        pool: "any".into(),
        overflow: false,
        marker_matches_work: true,
        owned: true,
        held: false,
        protected: false,
        br_retained: false,
        accepted_at: NOW - 3_600_000,
    }
}

fn facts(items: Vec<EvictItem>) -> EvictFacts {
    EvictFacts {
        current_ready_is_br: true,
        work_has_prior_br_ready: false,
        now_ms: NOW,
        items,
    }
}

fn gates() -> EvictGates {
    EvictGates {
        enabled: true,
        max_per_run: 25,
        min_age_ms: MIN_AGE,
        occupancy: None,
    }
}

fn removes(actions: &[EvictAction]) -> Vec<String> {
    actions
        .iter()
        .filter(|action| action.is_remove())
        .map(|action| action.hash().to_string())
        .collect()
}

fn reasons(actions: &[EvictAction]) -> Vec<EvictSkip> {
    actions
        .iter()
        .filter_map(|action| match action {
            EvictAction::Skip { reason, .. } => Some(*reason),
            EvictAction::Remove { .. } => None,
        })
        .collect()
}

/// Duplo do debrid: respostas roteirizadas de `remove` + os ids pedidos.
struct StubIo {
    results: Mutex<VecDeque<Result<bool, String>>>,
    calls: Mutex<Vec<String>>,
}

impl StubIo {
    fn new(results: Vec<Result<bool, String>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("trava").clone()
    }
}

impl AutofetchDebrid for StubIo {
    type Error = String;

    fn enqueue<'a>(
        &'a self,
        _candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, String> {
        Box::pin(async { Err("evict não enfileira".to_string()) })
    }

    fn status<'a>(
        &'a self,
        _hashes: &'a [String],
        _transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, String> {
        Box::pin(async { Ok(BTreeMap::new()) })
    }

    fn check<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, String> {
        Box::pin(async {
            Ok(CacheEvidence {
                known: false,
                cached: Vec::new(),
            })
        })
    }

    fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, String> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("trava")
                .push(transfer_id.to_string());
            self.results
                .lock()
                .expect("trava")
                .pop_front()
                .unwrap_or(Ok(true))
        })
    }

    fn evict<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, EvictOutcome, String> {
        // A porta real responde exatamente isto (nenhum serviço apaga por hash).
        Box::pin(async { Err("unsupported: evict".to_string()) })
    }

    fn account(&self) -> DebridFuture<'_, AccountEvidence, String> {
        Box::pin(async {
            Ok(AccountEvidence {
                used: None,
                max: None,
            })
        })
    }
}

/// (a) Sem `transfer_id` não há âncora de delete: a porta não apaga por hash.
#[tokio::test]
async fn sem_transfer_id_nao_apaga() {
    let mut sem_id = item("a");
    sem_id.transfer_id = None;
    let mut id_vazio = item("b");
    id_vazio.transfer_id = Some("   ".into());
    let mut sem_nome = item("c");
    sem_nome.name = None;

    let invalidos = vec![sem_id, id_vazio, sem_nome];
    let actions = plan(&facts(invalidos.clone()), &gates());
    assert!(removes(&actions).is_empty(), "nada pode virar Remove");
    assert_eq!(
        reasons(&actions),
        vec![
            EvictSkip::NoTransferId,
            EvictSkip::NoTransferId,
            EvictSkip::NoName
        ]
    );

    // Mesmo executando o passo, nenhum `remove` é pedido ao debrid.
    let io = StubIo::new(Vec::new());
    let report = run(&io, &facts(invalidos), &gates()).await;
    assert_eq!(report.counts(), (0, 0, 3));
    assert!(io.calls().is_empty(), "sem âncora não sai nenhum remove");
}

/// (b) Proteção durável, retenção BR e hold nunca apagam.
#[tokio::test]
async fn retencao_br_protecao_e_hold_nao_apagam() {
    let mut retido = item("a");
    retido.br_retained = true;
    let mut protegido = item("b");
    protegido.protected = true;
    let mut preso = item("c");
    preso.held = true;
    let mut sem_posse = item("d");
    sem_posse.owned = false;
    let mut outra_obra = item("e");
    outra_obra.marker_matches_work = false;
    let mut overflow = item("f");
    overflow.overflow = true;
    let mut dublado = item("g");
    dublado.pool = "br".into();

    let all = vec![
        retido, protegido, preso, sem_posse, outra_obra, overflow, dublado,
    ];
    let actions = plan(&facts(all.clone()), &gates());
    assert!(removes(&actions).is_empty());
    assert_eq!(
        reasons(&actions),
        vec![
            EvictSkip::BrRetained,
            EvictSkip::Protected,
            EvictSkip::Held,
            EvictSkip::NoOwnership,
            EvictSkip::OtherWork,
            EvictSkip::Overflow,
            EvictSkip::PoolBr,
        ]
    );

    let io = StubIo::new(Vec::new());
    let report = run(&io, &facts(all), &gates()).await;
    assert_eq!(report.counts(), (0, 0, 7));
    assert!(io.calls().is_empty(), "nenhum hash recusado foi pedido");
}

/// (c) Erro do debrid no meio para o passo, reporta e não tenta o resto.
#[tokio::test]
async fn erro_no_meio_para_o_passo_e_reporta() {
    let io = StubIo::new(vec![
        Ok(true),
        Err("quarantined: escrita anterior de resultado incerto".to_string()),
    ]);
    let report: EvictReport =
        run(&io, &facts(vec![item("a"), item("b"), item("c")]), &gates()).await;

    assert_eq!(report.counts(), (1, 1, 1));
    assert_eq!(report.removed_hashes(), vec!["a"]);
    assert_eq!(report.stop, Some(EvictStop::Quarantined));
    assert_eq!(report.skipped[0].reason, EvictSkip::NotAttempted);
    assert_eq!(io.calls(), vec!["id-a", "id-b"], "o terceiro não é tentado");
}

/// (d) Kill-switch OFF (e teto zero) devolvem plano vazio: zero delete.
#[tokio::test]
async fn kill_switch_desligado_devolve_plano_vazio() {
    let all = facts(vec![item("a"), item("b")]);
    assert!(plan(&all, &EvictGates::off()).is_empty());
    let mut teto_zero = gates();
    teto_zero.max_per_run = 0;
    assert!(plan(&all, &teto_zero).is_empty(), "0 desliga mesmo com ON");

    let io = StubIo::new(Vec::new());
    let report = run(&io, &all, &EvictGates::off()).await;
    assert_eq!(report.counts(), (0, 0, 0));
    assert_eq!(report, EvictReport::default());
    assert!(io.calls().is_empty());
}

/// (e) Duas passagens sobre a MESMA obra não apagam duas vezes: o hash sai do
/// registro com `removed_hashes()` (o `forgetObraHash` do TS) e a segunda
/// passagem não acha nada. Dentro de UM plano, o hash duplicado vira um delete.
#[tokio::test]
async fn dupla_chamada_nao_apaga_duas_vezes() {
    // Duas entradas do mesmo hash no registro F2: um único Remove.
    let mut repetido = item("A");
    repetido.hash = "a".into();
    let mut duplicado = item("a");
    duplicado.transfer_id = Some("id-a".into());
    let actions = plan(&facts(vec![repetido, duplicado]), &gates());
    assert_eq!(removes(&actions), vec!["a"], "um delete por hash");
    assert_eq!(reasons(&actions), vec![EvictSkip::Duplicate]);

    // Primeira passagem: apaga e devolve o que saiu.
    let io = StubIo::new(vec![Ok(true)]);
    let first = run(&io, &facts(vec![item("a"), item("b")]), &gates()).await;
    assert_eq!(first.counts(), (2, 0, 0));

    // Segunda passagem com o registro JÁ podado pelo que saiu: nada a fazer.
    let restante = facts(vec![item("a"), item("b")]);
    let saiu = first.removed_hashes();
    let podado = EvictFacts {
        items: restante
            .items
            .iter()
            .filter(|entry| !saiu.contains(&entry.hash))
            .cloned()
            .collect(),
        ..restante
    };
    let second = run(&io, &podado, &gates()).await;
    assert_eq!(second.counts(), (0, 0, 0));
    assert_eq!(io.calls(), vec!["id-a", "id-b"], "dois deletes no total");
}

/// Teto por passagem e piso de ocupação; sem prova de BR ready não sai nada.
#[test]
fn teto_piso_e_prova_de_br_limitam_a_passagem() {
    let all = facts(vec![item("a"), item("b"), item("c")]);
    let mut curto = gates();
    curto.max_per_run = 2;
    let actions = plan(&all, &curto);
    assert_eq!(removes(&actions), vec!["a", "b"]);
    assert_eq!(reasons(&actions), vec![EvictSkip::OverLimit]);

    // Conta folgada (usado <= piso): nada a podar.
    let mut conta_cheia = gates();
    conta_cheia.occupancy = Some(Occupancy {
        used: 600,
        floor: 600,
    });
    assert!(plan(&all, &conta_cheia).is_empty());
    // Vaga acima do piso limita o teto.
    conta_cheia.occupancy = Some(Occupancy {
        used: 601,
        floor: 600,
    });
    assert_eq!(removes(&plan(&all, &conta_cheia)).len(), 1);

    // Sem BR ready (nem atual, nem anterior) a obra não autoriza evicção.
    let sem_prova = EvictFacts {
        current_ready_is_br: false,
        work_has_prior_br_ready: false,
        ..facts(vec![item("a")])
    };
    let actions = plan(&sem_prova, &gates());
    assert!(removes(&actions).is_empty());
    assert_eq!(reasons(&actions), vec![EvictSkip::NoBrProof]);

    // Idade mínima: fallback recém-aceito fica.
    let mut novo = item("a");
    novo.accepted_at = NOW - 1_000;
    let actions = plan(&facts(vec![novo]), &gates());
    assert!(removes(&actions).is_empty());
    assert_eq!(reasons(&actions), vec![EvictSkip::TooYoung]);
}

/// (f) Via SEM âncora ([`plan_hashes`]): o worker nativo não tem `name` nem
/// `transfer_id` — quem os prova é a porta `evict`. O que NÃO se relaxa é o
/// veto: `may_delete` vale item a item, o dedupe segue de pé e o teto continua
/// sendo da passagem.
#[test]
fn plano_sem_ancora_nao_relaxa_o_veto() {
    // Sem âncora: autorizado por hash. Na via COM âncora, o MESMO item cai em
    // `NoTransferId` — é a mesma régua, só muda quem prova o id.
    let mut sem_ancora = item("a");
    sem_ancora.transfer_id = None;
    sem_ancora.name = None;
    let mut preso = item("b");
    preso.held = true;
    let mut sem_posse = item("c");
    sem_posse.owned = false;
    let mut novo = item("d");
    novo.accepted_at = NOW - 1_000;
    let repetido = item("a");

    let all = facts(vec![sem_ancora, preso, sem_posse, novo, repetido]);
    let plano = plan_hashes(&all, &gates());
    assert_eq!(plano.hashes, vec!["a"], "só o elegível, e uma vez só");
    assert_eq!(plano.skips.get("held"), Some(&1));
    assert_eq!(plano.skips.get("no-ownership"), Some(&1));
    assert_eq!(plano.skips.get("too-young"), Some(&1));
    assert_eq!(plano.skips.get("duplicate"), Some(&1));

    assert_eq!(
        reasons(&plan(&all, &gates())),
        vec![
            EvictSkip::NoTransferId,
            EvictSkip::Held,
            EvictSkip::NoOwnership,
            EvictSkip::TooYoung,
            EvictSkip::Duplicate,
        ]
    );

    // Desligado devolve plano VAZIO — nem hashes, nem rótulos inventados.
    let off = plan_hashes(&all, &EvictGates::off());
    assert!(off.hashes.is_empty());
    assert!(off.skips.is_empty());

    // O teto da passagem vale também sem âncora.
    let mut curto = gates();
    curto.max_per_run = 1;
    let dois = plan_hashes(&facts(vec![item("a"), item("b")]), &curto);
    assert_eq!(dois.hashes, vec!["a"]);
    assert_eq!(dois.skips.get("over-limit"), Some(&1));
}

// Golden de CONTRATO (fixture `.jsonl`) dos vetos e da ordem dos rótulos.
#[path = "evict_step_golden.rs"]
mod golden;
