//! Regra pura da parada DERIVADA por progresso (`derive_stall`), com relógio e
//! memória por parâmetro. Nenhum dublê de I/O: o oráculo é
//! `src/providers/autofetch-progress.ts:57`.

use std::collections::HashMap;

use adom_core::{
    derive_stall as core_derive_stall, ProgressLot, TorrentProgress as CoreProgress, TorrentStatus,
};

use super::{derive_stall, ProgressMemory, ProgressObservation, ProgressVerdict};
use crate::v3::TorrentProgress;

/// Relógio FIXO: a regra não olha tempo, e o teste prova isso.
const NOW: i64 = 1_700_000_000_000;
/// `DEBRID_AUTO_FETCH_STALL_STREAK` default (`Policy::from_env`).
const THRESHOLD: i64 = 3;

fn progress(bytes: f64, speed: f64, seeders: f64) -> TorrentProgress {
    TorrentProgress {
        bytes: Some(bytes),
        total: Some(1_000.0),
        speed: Some(speed),
        seeders: Some(seeders),
    }
}

fn at_state<'a>(
    state: &'a str,
    progress: &'a TorrentProgress,
    memory: Option<&'a ProgressMemory>,
    threshold: i64,
) -> ProgressObservation<'a> {
    ProgressObservation {
        state: Some(state),
        progress: Some(progress),
        transfer_id: Some("id-1"),
        memory,
        threshold,
        now_ms: NOW,
    }
}

fn memory_of(verdict: &ProgressVerdict) -> ProgressMemory {
    verdict.memory().cloned().expect("veredito com memória")
}

/// (a) Progresso avancando NUNCA é terminal, por mais passagens que rode.
#[test]
fn progresso_avancando_nunca_e_terminal() {
    let mut memory = ProgressMemory::default();
    for pass in 1..=20u32 {
        let bytes = f64::from(pass) * 10.0;
        // Velocidade positiva e seeders variando: movimento real.
        let sample = progress(bytes, 1_500.0, 0.0);
        let verdict = derive_stall(&at_state("downloading", &sample, Some(&memory), THRESHOLD));
        let next = memory_of(&verdict);
        assert!(
            !verdict.is_stalled(),
            "passagem {pass} com bytes crescendo não pode ser terminal"
        );
        assert_eq!(next.streak, 0, "movimento zera o contador");
        assert_eq!(next.last_bytes, bytes);
        memory = next;
    }
}

/// (b) N passagens sem progresso => terminal com o motivo DERIVADO, no limiar
/// exato do `autoFetchStallStreak` (`autofetch-progress.ts:109-111`).
///
/// A PRIMEIRA observação só abre a janela (`:88`: `streak: 0`, sem condenar),
/// então o limiar N conta as passagens seguintes à baseline — a mesma aritmética
/// do oráculo.
#[test]
fn n_passagens_sem_progresso_vira_terminal_derivado() {
    let sample = progress(500.0, 0.0, 0.0);
    let first = derive_stall(&at_state("downloading", &sample, None, THRESHOLD));
    assert!(
        matches!(first, ProgressVerdict::Moved(_)),
        "sem leitura anterior não há parada a provar"
    );
    let mut memory = memory_of(&first);
    assert_eq!(memory.streak, 0);
    for pass in 1..THRESHOLD {
        let verdict = derive_stall(&at_state("downloading", &sample, Some(&memory), THRESHOLD));
        assert!(
            !verdict.is_stalled(),
            "passagem {pass} < {THRESHOLD} ainda não é terminal"
        );
        assert!(matches!(verdict, ProgressVerdict::Still(_)));
        memory = memory_of(&verdict);
        assert_eq!(memory.streak, pass);
    }
    let verdict = derive_stall(&at_state("downloading", &sample, Some(&memory), THRESHOLD));
    assert!(verdict.is_stalled(), "no limiar a derivação condena");
    assert_eq!(memory_of(&verdict).streak, THRESHOLD);
}

/// (c) Qualquer progresso REINICIA o contador: a janela volta ao zero, mesmo
/// depois de quase condenar (`autofetch-progress.ts:92-108`).
#[test]
fn progresso_reinicia_o_contador() {
    let sample = progress(500.0, 0.0, 0.0);
    // Baseline (janela aberta) + `THRESHOLD - 1` passagens paradas: quase lá.
    let mut memory = memory_of(&derive_stall(&at_state(
        "downloading",
        &sample,
        None,
        THRESHOLD,
    )));
    for _ in 1..THRESHOLD {
        memory = memory_of(&derive_stall(&at_state(
            "downloading",
            &sample,
            Some(&memory),
            THRESHOLD,
        )));
    }
    assert_eq!(memory.streak, THRESHOLD - 1);

    // Um byte a mais: movimento real, janela nova.
    let avanco = progress(501.0, 0.0, 0.0);
    let verdict = derive_stall(&at_state("downloading", &avanco, Some(&memory), THRESHOLD));
    assert!(matches!(verdict, ProgressVerdict::Moved(_)));
    let reset = memory_of(&verdict);
    assert_eq!(reset.streak, 0);
    assert_eq!(reset.last_bytes, 501.0);

    // E o limiar precisa ser contado DE NOVO depois do reset.
    let verdict = derive_stall(&at_state("downloading", &avanco, Some(&reset), THRESHOLD));
    assert!(!verdict.is_stalled(), "streak residual herdado não condena");
    assert_eq!(memory_of(&verdict).streak, 1);
}

/// Velocidade positiva sozinha é movimento — `seeders: 0` nunca a sobrepõe
/// (`autofetch-progress.ts:102-108`).
#[test]
fn velocidade_positiva_zera_mesmo_com_seeders_zero() {
    let parado = progress(500.0, 0.0, 0.0);
    let prev = memory_of(&derive_stall(&at_state(
        "downloading",
        &parado,
        None,
        THRESHOLD,
    )));
    let prev = memory_of(&derive_stall(&at_state(
        "downloading",
        &parado,
        Some(&prev),
        THRESHOLD,
    )));
    assert_eq!(prev.streak, 1);

    let com_velocidade = progress(500.0, 2_000.0, 0.0);
    let verdict = derive_stall(&at_state(
        "downloading",
        &com_velocidade,
        Some(&prev),
        THRESHOLD,
    ));
    assert!(matches!(verdict, ProgressVerdict::Moved(_)));
    assert_eq!(memory_of(&verdict).streak, 0);
}

/// Regressão de bytes (contador resetado pelo serviço) e troca de transferência
/// também reiniciam (`autofetch-progress.ts:83-96`).
#[test]
fn regressao_e_troca_de_transferencia_reiniciam() {
    let sample = progress(500.0, 0.0, 0.0);
    let mut memory = ProgressMemory {
        last_bytes: 900.0,
        last_id: "id-1".to_string(),
        streak: 2,
        last_seen_ms: NOW - 120_000,
    };
    let verdict = derive_stall(&at_state("downloading", &sample, Some(&memory), THRESHOLD));
    assert!(matches!(verdict, ProgressVerdict::Moved(_)), "bytes caíram");
    assert_eq!(memory_of(&verdict).streak, 0);

    // Mesmo hash, transferência NOVA: a leitura anterior era de outro download.
    memory = ProgressMemory {
        last_bytes: 500.0,
        last_id: "id-antigo".to_string(),
        streak: 2,
        last_seen_ms: NOW - 120_000,
    };
    let mut outro_id = at_state("downloading", &sample, Some(&memory), THRESHOLD);
    outro_id.transfer_id = Some("id-2");
    let verdict = derive_stall(&outro_id);
    assert!(matches!(verdict, ProgressVerdict::Moved(_)));
    assert_eq!(memory_of(&verdict).last_id, "id-2");
}

/// Fail-safe: sem progresso, com state fora de `downloading`, com campo não
/// numérico ou já completo, a resposta é `NoSignal` — memória INTOCADA e nada
/// terminal (`autofetch-progress.ts:65-79`).
#[test]
fn sem_sinal_valido_devolve_nao_terminal_e_nao_toca_a_memoria() {
    let parado = progress(500.0, 0.0, 0.0);
    let prev = ProgressMemory {
        last_bytes: 500.0,
        last_id: "id-1".to_string(),
        streak: 2,
        last_seen_ms: NOW - 120_000,
    };

    // Sem o campo de progresso (serviço que não mede bytes).
    let mut sem_progresso = at_state("downloading", &parado, Some(&prev), THRESHOLD);
    sem_progresso.progress = None;
    assert_eq!(derive_stall(&sem_progresso), ProgressVerdict::NoSignal);

    // Estado que não é download ativo.
    for state in ["queued", "processing", "unknown", "ready", "dead"] {
        let verdict = derive_stall(&at_state(state, &parado, Some(&prev), THRESHOLD));
        assert_eq!(verdict, ProgressVerdict::NoSignal, "state {state}");
        assert!(verdict.memory().is_none(), "memória intocada em {state}");
    }

    // Campo ausente e `total <= 0`.
    for quebrado in [
        TorrentProgress {
            bytes: None,
            ..parado.clone()
        },
        TorrentProgress {
            total: Some(0.0),
            ..parado.clone()
        },
        TorrentProgress {
            speed: None,
            ..parado.clone()
        },
        TorrentProgress {
            seeders: None,
            ..parado.clone()
        },
    ] {
        assert_eq!(
            derive_stall(&at_state("downloading", &quebrado, Some(&prev), THRESHOLD)),
            ProgressVerdict::NoSignal
        );
    }

    // Completo/limítrofe: o `ready` cuida.
    let completo = progress(1_000.0, 0.0, 0.0);
    assert_eq!(
        derive_stall(&at_state("downloading", &completo, Some(&prev), THRESHOLD)),
        ProgressVerdict::NoSignal
    );
}

/// `threshold <= 0` desliga a derivação por inteiro: a memória até acumula,
/// mas o veredito NUNCA é terminal (`autofetch-progress.ts:23,111`).
#[test]
fn limiar_zero_desliga_a_derivacao() {
    let parado = progress(500.0, 0.0, 0.0);
    let mut memory = memory_of(&derive_stall(&at_state("downloading", &parado, None, 0)));
    for pass in 1..=10 {
        let verdict = derive_stall(&at_state("downloading", &parado, Some(&memory), 0));
        assert!(!verdict.is_stalled(), "passagem {pass} com limiar 0");
        memory = memory_of(&verdict);
        assert_eq!(memory.streak, pass);
    }
}

/// (e) Regra pura com relógio FIXO: o carimbo da memória é o `now_ms` recebido,
/// e mudar o relógio NÃO muda o veredito (a régua é contagem de passagens).
#[test]
fn regra_pura_com_relogio_fixo() {
    let parado = progress(500.0, 0.0, 0.0);
    let mut memory = memory_of(&derive_stall(&at_state(
        "downloading",
        &parado,
        None,
        THRESHOLD,
    )));
    assert_eq!(memory.last_seen_ms, NOW);
    for pass in 1..=THRESHOLD {
        let mut obs = at_state("downloading", &parado, Some(&memory), THRESHOLD);
        obs.now_ms = NOW + pass * 120_000;
        let verdict = derive_stall(&obs);
        let next = memory_of(&verdict);
        assert_eq!(next.last_seen_ms, NOW + pass * 120_000);
        memory = next;
    }
    assert_eq!(memory.streak, THRESHOLD);

    // Mesmo estado, relógio 10 anos à frente: só o carimbo muda.
    let mut futuro = at_state("downloading", &parado, Some(&memory), THRESHOLD);
    futuro.now_ms = NOW + 315_360_000_000;
    let verdict = derive_stall(&futuro);
    assert!(verdict.is_stalled());
    assert_eq!(memory_of(&verdict).streak, THRESHOLD + 1);
}

/// (f) ANTI-DERIVA: `adom-core` já tem o porte puro desta MESMA regra
/// (`autofetch_progress.rs:120`, commit `c5d83cb5`) e é dele que a ponte napi
/// serve. Duas cópias da régua só são seguras enquanto decidirem IGUAL: aqui a
/// MESMA sequência de status alimenta as duas, e cada passo exige veredito
/// idêntico. Se uma delas derivar, este teste fica vermelho.
#[test]
fn regra_local_concorda_com_o_porte_do_nucleo() {
    // (state, bytes, total, speed, id) — cobre cada ramo de `autofetch-progress.ts`.
    let roteiro: &[(Option<&str>, f64, f64, f64, &str)] = &[
        (Some("downloading"), 100.0, 1_000.0, 0.0, "id-1"),
        (Some("downloading"), 100.0, 1_000.0, 0.0, "id-1"),
        (Some("downloading"), 100.0, 1_000.0, 0.0, "id-1"),
        (Some("downloading"), 100.0, 1_000.0, 0.0, "id-1"),
        // bytes crescendo: zera
        (Some("downloading"), 140.0, 1_000.0, 0.0, "id-1"),
        // bytes parados com velocidade positiva: zera
        (Some("downloading"), 140.0, 1_000.0, 900.0, "id-1"),
        // regressão: zera
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-1"),
        // fora de `downloading`: sem sinal
        (Some("ready"), 120.0, 1_000.0, 0.0, "id-1"),
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-1"),
        // troca de transferência: zera
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-2"),
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-2"),
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-2"),
        (Some("downloading"), 120.0, 1_000.0, 0.0, "id-2"),
        // completo: sem sinal
        (Some("downloading"), 1_000.0, 1_000.0, 0.0, "id-2"),
        // total inválido: sem sinal
        (Some("downloading"), 500.0, 0.0, 0.0, "id-2"),
        // campo não numérico: sem sinal
        (Some("downloading"), f64::NAN, 1_000.0, 0.0, "id-2"),
        // sem estado: sem sinal
        (None, 500.0, 1_000.0, 0.0, "id-2"),
        // parado de novo: as duas precisam contar do ZERO
        (Some("downloading"), 500.0, 1_000.0, 0.0, "id-2"),
        (Some("downloading"), 500.0, 1_000.0, 0.0, "id-2"),
        (Some("downloading"), 500.0, 1_000.0, 0.0, "id-2"),
    ];
    let hash = "abc".to_string();
    // `None` (e não a memória default) na primeira passagem: o núcleo começa sem
    // entrada, e `last_bytes: 0.0` de um `Default` não é o mesmo que "sem baseline".
    let mut mine: Option<ProgressMemory> = None;
    let mut core = adom_core::ProgressMemory::new();
    for (idx, (state, bytes, total, speed, id)) in roteiro.iter().enumerate() {
        let local = TorrentProgress {
            bytes: Some(*bytes),
            total: Some(*total),
            speed: Some(*speed),
            seeders: Some(0.0),
        };
        let verdict = derive_stall(&ProgressObservation {
            state: *state,
            progress: Some(&local),
            transfer_id: Some(id),
            memory: mine.as_ref(),
            threshold: THRESHOLD,
            now_ms: NOW + idx as i64,
        });
        // Sem sinal, a memória fica INTOCADA — igual ao worker.
        if let Some(next) = verdict.memory() {
            mine = Some(next.clone());
        }

        let mut statuses = HashMap::new();
        statuses.insert(
            hash.clone(),
            TorrentStatus {
                state: state.unwrap_or("unknown").to_string(),
                id: Some((*id).to_string()),
                progress: Some(CoreProgress {
                    bytes: *bytes,
                    total: *total,
                    speed: *speed,
                    seeders: 0.0,
                }),
            },
        );
        let lot = ProgressLot {
            adapter_id: "alldebrid",
            account: "conta",
            hashes: std::slice::from_ref(&hash),
            threshold: THRESHOLD,
        };
        let out = core_derive_stall(&mut core, &lot, &statuses);
        assert_eq!(
            verdict.is_stalled(),
            out.stalled.contains(&hash),
            "passo {idx}: a regra local e o porte do núcleo divergiram"
        );
    }
}
