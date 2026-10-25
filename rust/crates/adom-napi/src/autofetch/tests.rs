//! Testes unitários do `decide` (puro, sem Node).

use super::*;

fn gates() -> EnqueueGatesIn {
    EnqueueGatesIn {
        is_paused: false,
        is_dead: false,
        is_cached: false,
        marker_active: false,
        lock_acquired: true,
        slot_acquired: true,
        obra_cap_granted: true,
        account_blocked: false,
        budget_granted: true,
    }
}

fn options() -> PoolOptionsIn {
    PoolOptionsIn {
        season: None,
        min_seeders: 1.0,
        pt_first: true,
        auto_fetch_max: 3.0,
        queue_depth: 0.0,
        top_seeds_max: 2.0,
        rare_max: 0.0,
        rare_threshold: 0.0,
        rare_max_seeders: 0.0,
        auto_fetch_br: true,
        adapter_cache_check: true,
        adapter_autofetch_source: false,
        any_dubbed: true,
        top_seeds: true,
        seeds_blocked: false,
    }
}

fn policy() -> SeedsPolicyIn {
    SeedsPolicyIn {
        dubbed_only: false,
        cached_only: true,
        max_size_gb: 0.0,
        seeds_max_gb: 0.0,
        seeds_max_quality: "1080p".into(),
    }
}

fn br_stream(hash: &str, quality: &str) -> AutofetchStreamIn {
    AutofetchStreamIn {
        info_hash: Some(hash.into()),
        title: Some(format!("Movie 1988 {quality} DUBLADO")),
        name: None,
        quality: Some(quality.into()),
        seeders: Some(10.0),
        size_bytes: Some(1_000_000_000.0),
        pack_bytes: None,
        is_br: true,
        is_dubbed: true,
        is_dub_claim: false,
        is_bank_dub: false,
        is_lied: false,
        is_cached: false,
        from_fallback: false,
        fallback_fetchable: false,
        viable: true,
    }
}

fn input(streams: Vec<AutofetchStreamIn>) -> AutofetchInput {
    AutofetchInput {
        streams,
        options: options(),
        seeds_policy: policy(),
        gates: gates(),
        obra_entries: Vec::new(),
        pending_reservations: Vec::new(),
    }
}

#[test]
fn toggle_desligado_nao_seleciona() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.options.auto_fetch_br = false;
    let d = decide(&inp);
    assert!(d.immediates.is_empty());
    assert!(d.trace.disabled);
    assert_eq!(d.trace.pool, "none");
}

#[test]
fn pool_br_vira_imediato() {
    let d = decide(&input(vec![
        br_stream("aaa", "1080p"),
        br_stream("bbb", "720p"),
    ]));
    assert_eq!(d.trace.pool, "br");
    assert_eq!(d.immediates.len(), 2);
    assert_eq!(d.immediates[0].info_hash, "aaa");
    assert!(d.skips.is_empty());
}

#[test]
fn portao_fechado_vira_skip_com_rollback() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.gates.is_paused = true;
    let d = decide(&inp);
    assert!(d.immediates.is_empty());
    assert_eq!(d.skips.len(), 1);
    assert_eq!(d.skips[0].reason, "paused");
    assert_eq!(d.skips[0].rollback, vec!["hold".to_string()]);
}

#[test]
fn stream_inviavel_sai_do_pool_br() {
    let mut s = br_stream("aaa", "1080p");
    s.viable = false;
    let d = decide(&input(vec![s]));
    assert_eq!(d.trace.pool, "none");
    assert!(d.immediates.is_empty());
}

#[test]
fn obra_status_conta_registro_e_reservas() {
    let mut inp = input(vec![br_stream("aaa", "1080p")]);
    inp.obra_entries.push(ObraRecordIn {
        hash: "x".into(),
        pool: "br".into(),
        accepted_at: 0.0,
        title: None,
        br: true,
        dubbed: true,
        id: None,
        quality: Some("720p".into()),
        overflow: false,
    });
    inp.pending_reservations.push(PendingIn {
        id: "1".into(),
        pool: "seeds".into(),
        rare: false,
        at: 0.0,
        hash: "y".into(),
        quality: None,
        overflow: false,
    });
    let d = decide(&inp);
    assert_eq!(d.obra_status.br, 1);
    assert_eq!(d.obra_status.seeds, 1);
    assert_eq!(d.obra_status.total, 2);
    assert_eq!(d.obra_status.view_len, 2);
}

/// Caso vivo reduzido (Shawshank, shadow 2026-10-15): o oráculo usa
/// `pickBrDubbedByTargetQualities` — o 1º uncached de CADA faixa (1080 e 720)
/// entra ANTES dos alternates de 1080. O pick simples trocava o 2º imediato
/// por um alternate da mesma faixa (divergência `(immediates) pool=br`).
#[test]
fn pool_br_usa_pick_por_faixa_alvo() {
    let mut a = br_stream("aaa", "1080p");
    let mut b = br_stream("bbb", "1080p");
    let mut c = br_stream("ccc", "1080p");
    let mut claim = br_stream("ddd", "720p");
    a.seeders = None;
    b.seeders = None;
    c.seeders = None;
    claim.seeders = None;
    claim.is_dubbed = false;
    claim.is_dub_claim = true;
    let mut inp = input(vec![a, b, c, claim]);
    inp.options.auto_fetch_max = 2.0;
    let out = decide(&inp);
    assert_eq!(out.trace.pool, "br");
    let hashes: Vec<&str> = out
        .immediates
        .iter()
        .map(|x| x.info_hash.as_str())
        .collect();
    assert_eq!(hashes, vec!["aaa", "ddd"]);
}

/// `seeds_blocked` (o `seedsSelectionBlock` do TS, ex. `seeds-playable` com
/// `cachedOnly=false`) bloqueia o pool seeds PRIMÁRIO e o FALLBACK seeds —
/// sem isso a fila do Rust nascia com `:seeds` que o TS não pôs (divergência
/// `(queue) pool=br`, shadow 2026-10-15).
#[test]
fn seeds_blocked_corta_primario_e_fallback() {
    // Sem BR/any: com o bloqueio, nada é selecionado (pool none).
    let mut inp = input(vec![]);
    inp.options.seeds_blocked = true;
    inp.options.queue_depth = 2.0;
    let d = decide(&inp);
    assert_eq!(d.trace.pool, "none");
    assert!(d.immediates.is_empty());
    assert!(d.queue.is_empty());

    // Com BR primário: a fila recebe só o excedente br, sem fallback seeds.
    let mut br = br_stream("br1", "1080p");
    br.seeders = None;
    let mut seeds = br_stream("sd1", "1080p");
    seeds.is_br = false;
    seeds.is_dubbed = false;
    let mut inp = input(vec![br, seeds]);
    inp.options.seeds_blocked = true;
    inp.options.auto_fetch_max = 1.0;
    inp.options.queue_depth = 2.0;
    let d = decide(&inp);
    assert_eq!(d.trace.pool, "br");
    assert_eq!(d.queue.len(), 0);
}

// ---------------------------------------------------------------------------
// Bindings das regras puras avulsas (`rules`)
// ---------------------------------------------------------------------------

/// As regras portadas ficam alcançáveis pelo napi: se alguém apagar um binding
/// ou trocar a régua do núcleo, este teste cai. A chave leva o prefixo
/// VERSIONADO do namespace (`autofetch:v3:dead:*`), não a forma curta do plano.
#[test]
fn napi_reexpoe_as_regras_puras_do_chupim() {
    assert_eq!(
        rules::dead_key("premiumize".into(), "acc".into(), "AABBCCDD".into()),
        "autofetch:v3:dead:premiumize:acc:aabbccdd"
    );
    // Teto por obra com 720p registrado: 1080p cabe como reserva extra.
    let fatos = vec![rules::ObraOverflowEntryIn {
        pool: "br".into(),
        quality: "720p".into(),
        overflow: false,
    }];
    assert!(rules::overflow_upgrade_allowed(
        fatos,
        "br".into(),
        "1080p".into()
    ));
}

/// Os portões e a tabela de rollback vêm do núcleo, na ordem sagrada.
#[test]
fn napi_classifica_portao_e_devolve_o_rollback() {
    let mut g = gates();
    g.is_paused = true;
    assert_eq!(rules::classify_enqueue(g).as_deref(), Some("paused"));
    assert_eq!(
        rules::rollback_for("paused".into()),
        Some(vec!["hold".to_string()])
    );
    // `in-flight` retém o hold de propósito: o hash está em voo agora.
    assert_eq!(rules::rollback_for("in-flight".into()), Some(Vec::new()));
    assert_eq!(rules::rollback_for("unknown".into()), None);

    // Sem portão fechado, o candidato é enfileirável.
    assert_eq!(rules::classify_enqueue(gates()), None);
}

/// Posse do expirado: fora da AllDebrid a remoção histórica é preservada.
#[test]
fn napi_exige_prova_de_posse_do_expirado() {
    fn base() -> rules::ExpiredFactsIn {
        rules::ExpiredFactsIn {
            hash_empty: false,
            is_cleanup_protected: false,
            adapter_is_alldebrid: true,
            has_marker: true,
            has_adsub: false,
            has_snapshot: true,
            in_snapshot: false,
        }
    }
    // Marker prova a posse e o hash não é acervo do usuário: pode apagar.
    assert!(rules::expired_removal_allowed(base()));
    // Snapshot frio fecha o fail-safe (a MESMA autoridade do dropUncached).
    let mut sem_snapshot = base();
    sem_snapshot.has_snapshot = false;
    assert!(!rules::expired_removal_allowed(sem_snapshot));
    // Preexistente do usuário nunca é do Chupim.
    let mut do_usuario = base();
    do_usuario.in_snapshot = true;
    assert!(!rules::expired_removal_allowed(do_usuario));
}

/// A memória de progresso é a do processo (o `Map` do TS) e é limpa por hash.
#[test]
fn napi_deriva_parada_e_esquece_o_hash() {
    let lot = |hashes: Vec<String>| rules::ProgressLotIn {
        adapter_id: "napi-progress".into(),
        account: "acc".into(),
        hashes,
        threshold: 1.0,
    };
    let status = |bytes: f64| {
        vec![rules::TorrentStatusPairIn {
            hash: "abc".into(),
            status: rules::TorrentStatusIn {
                state: "downloading".into(),
                id: Some("t1".into()),
                progress: Some(rules::TorrentProgressIn {
                    bytes,
                    total: 100.0,
                    speed: 0.0,
                    seeders: 0.0,
                }),
            },
        }]
    };
    // Primeira leitura só fixa a baseline: bytes parados valem 1 sinal.
    let first = rules::derive_stall(lot(vec!["abc".into()]), status(10.0));
    assert_eq!(first.signals, 1);
    assert!(first.stalled.is_empty());
    // Segunda leitura parada cruza o limiar (streak 1).
    let second = rules::derive_stall(lot(vec!["abc".into()]), status(10.0));
    assert_eq!(second.stalled, vec!["abc".to_string()]);

    assert_eq!(
        rules::forget_progress("napi-progress".into(), "acc".into(), "abc".into()),
        0
    );
    assert_eq!(rules::progress_memory_size(), 0);
}
