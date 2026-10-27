use adom_autofetch::v3::{select_drain_candidate, QueueCandidate};

fn c(hash: &str) -> QueueCandidate {
    serde_json::from_value(serde_json::json!({"infoHash":hash})).unwrap()
}

#[test]
fn obsoleto_sai_hold_espera_cap_volta_a_frente_e_proximo_recebe_lease() {
    let queue = vec![
        c("morto"),
        c("hold"),
        c("cap"),
        c("ok"),
        c("morto2"),
        c("fim"),
    ];
    let result = select_drain_candidate(
        queue,
        |c| Ok::<_, ()>(c.info_hash.starts_with("morto")),
        |c| Ok::<_, ()>(c.info_hash == "hold"),
        |c| Ok::<_, ()>(if c.info_hash == "cap" { None } else { Some(42) }),
    )
    .unwrap();
    assert_eq!(result.next.unwrap().info_hash, "ok");
    assert_eq!(result.lease, Some(42));
    assert_eq!(result.cap_deferred, 1);
    assert_eq!(
        result
            .remaining
            .iter()
            .map(|c| c.info_hash.as_str())
            .collect::<Vec<_>>(),
        ["cap", "hold", "fim"]
    );
}

#[test]
fn sem_vaga_nenhum_e_perdido_e_a_ordem_dos_adiados_e_preservada() {
    let result = select_drain_candidate(
        vec![c("hold"), c("a"), c("b")],
        |_| Ok::<_, ()>(false),
        |c| Ok::<_, ()>(c.info_hash == "hold"),
        |_| Ok::<Option<()>, ()>(None),
    )
    .unwrap();
    assert!(result.next.is_none());
    assert_eq!(result.cap_deferred, 2);
    assert_eq!(
        result
            .remaining
            .iter()
            .map(|c| c.info_hash.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "hold"]
    );
}

#[test]
fn erro_de_guarda_sobe_ao_chamador_sem_inventar_escolha() {
    let result = select_drain_candidate(
        vec![c("a")],
        |_| Err::<bool, _>("indisponivel"),
        |_| Ok(false),
        |_| Ok(Some(())),
    );
    assert_eq!(result.unwrap_err(), "indisponivel");
}
