//! Paridade da cascata com `autofetch-pickers.test.ts`, `autofetch-obra-cap.test.ts`
//! e a metade pura de `autofetch-seeds*.test.ts`. Stubs puros: nada de rede,
//! relógio ou config — os fatos entram medidos.

use super::{
    cascade, CascadeCandidate, CascadeDecision, CascadeDefer, CascadeDrop, CascadeFacts,
    CascadePool, ObraCapFacts, SeedsBlock, SeedsPurge, SeedsTrace,
};
use adom_core::{ObraEntry, SeedsSelectionBlockReason, SeedsStopReason};

fn cand(hash: &str, pool: CascadePool, quality: &str) -> CascadeCandidate {
    CascadeCandidate {
        info_hash: hash.to_string(),
        pool,
        quality: Some(quality.to_string()),
        slot_limit: None,
        rare: false,
        cached: false,
        dead: false,
        adrm: false,
        viable: true,
    }
}

fn br(hash: &str, quality: &str) -> CascadeCandidate {
    cand(hash, CascadePool::Br, quality)
}

fn attempted(decision: &CascadeDecision) -> Vec<&str> {
    decision
        .attempts
        .iter()
        .map(|attempt| attempt.info_hash.as_str())
        .collect()
}

fn deferred(decision: &CascadeDecision) -> Vec<(&str, CascadeDefer)> {
    decision
        .deferred
        .iter()
        .map(|item| (item.candidate.info_hash.as_str(), item.reason))
        .collect()
}

fn dropped(decision: &CascadeDecision) -> Vec<(&str, CascadeDrop)> {
    decision
        .dropped
        .iter()
        .map(|item| (item.info_hash.as_str(), item.reason))
        .collect()
}

#[test]
fn adrm_e_morto_saem_antes_dos_pools_sem_parar_a_busca() {
    let mut adrm = br("aaa", "1080p");
    adrm.adrm = true;
    let mut dead = br("bbb", "1080p");
    dead.dead = true;
    let decision = cascade(
        &CascadeFacts::default(),
        vec![adrm, dead, br("ccc", "1080p")],
    );
    assert_eq!(decision.pool, Some(CascadePool::Br));
    assert_eq!(attempted(&decision), vec!["ccc"]);
    assert_eq!(
        dropped(&decision),
        vec![("aaa", CascadeDrop::Adrm), ("bbb", CascadeDrop::Dead)]
    );
}

#[test]
fn hash_vazio_e_waiver_do_piso_saem_antes_dos_pools() {
    let mut waived = br("ddd", "1080p");
    waived.viable = false;
    let decision = cascade(
        &CascadeFacts::default(),
        vec![br("", "1080p"), waived, br("eee", "720p")],
    );
    assert_eq!(attempted(&decision), vec!["eee"]);
    assert_eq!(
        dropped(&decision),
        vec![
            ("", CascadeDrop::EmptyHash),
            ("ddd", CascadeDrop::SeedFloorWaived)
        ]
    );
}

#[test]
fn dedupe_por_hash_primeira_ocorrencia_vence() {
    let decision = cascade(
        &CascadeFacts::default(),
        vec![br("abc", "1080p"), br("ABC", "1080p")],
    );
    assert_eq!(attempted(&decision), vec!["abc"]);
    assert_eq!(dropped(&decision), vec![("ABC", CascadeDrop::Duplicate)]);
}

#[test]
fn cobertura_e_por_qualidade_alvo_nao_pelo_pool() {
    let facts = CascadeFacts {
        covered_qualities: vec!["720p".to_string()],
        ..CascadeFacts::default()
    };
    let decision = cascade(
        &facts,
        vec![br("h720", "720p"), br("h1080", "1080p"), br("h4k", "2160p")],
    );
    assert_eq!(attempted(&decision), vec!["h1080", "h4k"]);
    assert_eq!(
        dropped(&decision),
        vec![("h720", CascadeDrop::AlreadyCached)]
    );
    assert_eq!(decision.seeds, SeedsTrace::NotEvaluated);
}

#[test]
fn fora_da_faixa_alvo_qualquer_br_em_cache_derruba_o_pool() {
    let no_cache = cascade(&CascadeFacts::default(), vec![br("sd", "SD")]);
    assert_eq!(attempted(&no_cache), vec!["sd"]);
    let with_cache = cascade(
        &CascadeFacts {
            has_cached_br_dubbed: true,
            ..CascadeFacts::default()
        },
        vec![br("sd", "SD"), br("unk", "unknown")],
    );
    assert!(with_cache.attempts.is_empty());
    assert_eq!(
        dropped(&with_cache),
        vec![
            ("sd", CascadeDrop::AlreadyCached),
            ("unk", CascadeDrop::AlreadyCached)
        ]
    );
}

#[test]
fn cache_desconhecido_nao_escolhe_pool_nenhum() {
    let decision = cascade(
        &CascadeFacts {
            cache_known: false,
            ..CascadeFacts::default()
        },
        vec![br("aaa", "1080p")],
    );
    assert_eq!(decision.pool, None);
    assert!(decision.attempts.is_empty());
    assert_eq!(dropped(&decision), vec![("aaa", CascadeDrop::UnknownCache)]);
}

#[test]
fn desligado_derruba_tudo_e_pausado_adia_sem_perder() {
    let off = cascade(
        &CascadeFacts {
            enabled: false,
            ..CascadeFacts::default()
        },
        vec![br("aaa", "1080p")],
    );
    assert_eq!(dropped(&off), vec![("aaa", CascadeDrop::Disabled)]);

    let paused = cascade(
        &CascadeFacts {
            paused: true,
            ..CascadeFacts::default()
        },
        vec![br("aaa", "1080p"), br("bbb", "720p")],
    );
    assert!(paused.attempts.is_empty());
    assert_eq!(
        deferred(&paused),
        vec![("aaa", CascadeDefer::Paused), ("bbb", CascadeDefer::Paused)]
    );
}

#[test]
fn pool_any_para_com_dublado_tocavel_e_seeds_ficam_adiados() {
    let decision = cascade(
        &CascadeFacts {
            has_cached_any_dubbed: true,
            ..CascadeFacts::default()
        },
        vec![
            cand("any1", CascadePool::Any, "1080p"),
            cand("seed1", CascadePool::Seeds, "1080p"),
        ],
    );
    assert_eq!(decision.pool, Some(CascadePool::Any));
    assert_eq!(dropped(&decision), vec![("any1", CascadeDrop::StopHasBr)]);
    assert_eq!(
        deferred(&decision),
        vec![("seed1", CascadeDefer::LowerPool)]
    );
}

#[test]
fn pool_inferior_nao_se_perde_na_cascata() {
    let decision = cascade(
        &CascadeFacts::default(),
        vec![
            br("b1", "1080p"),
            cand("a1", CascadePool::Any, "1080p"),
            cand("s1", CascadePool::Seeds, "1080p"),
        ],
    );
    assert_eq!(decision.pool, Some(CascadePool::Br));
    assert_eq!(attempted(&decision), vec!["b1"]);
    assert_eq!(
        deferred(&decision),
        vec![
            ("a1", CascadeDefer::LowerPool),
            ("s1", CascadeDefer::LowerPool)
        ]
    );
}

#[test]
fn sonda_pendente_bloqueia_seeds_sem_purgar_a_fila() {
    let decision = cascade(
        &CascadeFacts {
            probe_pending: true,
            ..CascadeFacts::default()
        },
        vec![cand("s1", CascadePool::Seeds, "1080p")],
    );
    assert_eq!(
        decision.seeds,
        SeedsTrace::Blocked(SeedsBlock::BrProbePending)
    );
    assert_eq!(decision.seeds.label(), "blocked:br-probe-pending");
    assert_eq!(decision.purge, SeedsPurge::None);
    assert_eq!(
        dropped(&decision),
        vec![("s1", CascadeDrop::BrProbePending)]
    );
}

#[test]
fn bloqueio_de_selecao_e_stop_gate_purgam_a_fila_de_seeds() {
    let dubbed_only = cascade(
        &CascadeFacts {
            seeds_block: Some(SeedsSelectionBlockReason::DubbedOnly),
            ..CascadeFacts::default()
        },
        vec![cand("s1", CascadePool::Seeds, "1080p")],
    );
    assert_eq!(dubbed_only.seeds.label(), "blocked:dubbed-only");
    assert_eq!(dubbed_only.purge, SeedsPurge::All);
    assert_eq!(dropped(&dubbed_only), vec![("s1", CascadeDrop::DubbedOnly)]);

    let stop = cascade(
        &CascadeFacts {
            seeds_stop: Some(SeedsStopReason::StopHasCached),
            ..CascadeFacts::default()
        },
        vec![cand("s1", CascadePool::Seeds, "1080p")],
    );
    assert_eq!(stop.seeds.label(), "blocked:stop-has-cached");
    assert_eq!(stop.purge, SeedsPurge::All);
    assert_eq!(dropped(&stop), vec![("s1", CascadeDrop::StopHasCached)]);
}

#[test]
fn titulo_raro_mantem_aquecimento_e_purga_so_o_cacheado() {
    let mut cached = cand("s1", CascadePool::Seeds, "1080p");
    cached.cached = true;
    let decision = cascade(
        &CascadeFacts {
            rare_over_cached: true,
            ..CascadeFacts::default()
        },
        vec![cached, cand("s2", CascadePool::Seeds, "1080p")],
    );
    assert_eq!(decision.seeds, SeedsTrace::Allowed);
    assert_eq!(decision.seeds.label(), "allowed");
    assert_eq!(decision.purge, SeedsPurge::CachedOnly);
    assert_eq!(attempted(&decision), vec!["s2"]);
    assert_eq!(dropped(&decision), vec![("s1", CascadeDrop::AlreadyCached)]);
}

#[test]
fn teto_da_obra_adia_o_excedente_sem_perder() {
    let facts = CascadeFacts {
        obra: ObraCapFacts {
            caps: [1, 3, 3],
            current: [0, 0, 0],
            entries: Vec::new(),
        },
        ..CascadeFacts::default()
    };
    let decision = cascade(&facts, vec![br("b1", "720p"), br("b2", "720p")]);
    assert_eq!(attempted(&decision), vec!["b1"]);
    assert_eq!(deferred(&decision), vec![("b2", CascadeDefer::ObraCap)]);
}

#[test]
fn overflow_de_upgrade_abre_uma_reserva_por_janela() {
    let facts = CascadeFacts {
        obra: ObraCapFacts {
            caps: [1, 3, 3],
            current: [1, 0, 0],
            entries: vec![ObraEntry {
                pool: "br".to_string(),
                quality: "720p".to_string(),
                overflow: false,
            }],
        },
        ..CascadeFacts::default()
    };
    let decision = cascade(&facts, vec![br("b1080", "1080p"), br("b1080b", "1080p")]);
    assert_eq!(decision.attempts.len(), 1);
    assert!(decision.attempts[0].overflow);
    assert_eq!(deferred(&decision), vec![("b1080b", CascadeDefer::ObraCap)]);
}

#[test]
fn vaga_conta_e_orcamento_adiam_na_ordem_do_enqueue() {
    let sem_vaga = cascade(
        &CascadeFacts {
            slots: 0,
            ..CascadeFacts::default()
        },
        vec![br("b1", "1080p")],
    );
    assert_eq!(
        deferred(&sem_vaga),
        vec![("b1", CascadeDefer::SearchSlotBusy)]
    );

    let conta = cascade(
        &CascadeFacts {
            account_blocked: true,
            ..CascadeFacts::default()
        },
        vec![br("b1", "1080p")],
    );
    assert_eq!(deferred(&conta), vec![("b1", CascadeDefer::AccountGate)]);

    // Orçamento cheio é BACKOFF, nunca recusa: o candidato volta para a fila.
    let orcamento = cascade(
        &CascadeFacts {
            budget_blocked: true,
            ..CascadeFacts::default()
        },
        vec![br("b1", "1080p")],
    );
    assert!(orcamento.dropped.is_empty());
    assert_eq!(
        deferred(&orcamento),
        vec![("b1", CascadeDefer::BudgetBackoff)]
    );
    assert_eq!(CascadeDefer::BudgetBackoff.as_str(), "budget");
}

#[test]
fn vaga_consumida_adia_o_resto_na_ordem_de_entrada() {
    let decision = cascade(
        &CascadeFacts {
            slots: 1,
            ..CascadeFacts::default()
        },
        vec![br("b1", "1080p"), br("b2", "1080p")],
    );
    assert_eq!(attempted(&decision), vec!["b1"]);
    assert_eq!(
        deferred(&decision),
        vec![("b2", CascadeDefer::SearchSlotBusy)]
    );
}

#[test]
fn rotulos_do_pool_e_do_trace_batem_com_o_ts() {
    assert_eq!(CascadePool::Br.as_str(), "br");
    assert_eq!(CascadePool::Any.as_str(), "any");
    assert_eq!(CascadePool::Seeds.as_str(), "seeds");
    assert_eq!(CascadePool::parse("seeds"), Some(CascadePool::Seeds));
    assert_eq!(CascadePool::parse("top"), None);
    assert_eq!(SeedsTrace::NotEvaluated.label(), "n/a");
    assert_eq!(CascadeDrop::Adrm.as_str(), "adrm");
    assert_eq!(CascadeDefer::ObraCap.as_str(), "obra-cap");
    assert_eq!(CascadeDefer::LowerPool.as_str(), "lower-pool");
}
