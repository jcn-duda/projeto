use super::*;

#[test]
fn scopes_and_hashes_validos_sao_normalizados_sem_segredos() {
    let body = json!({
        "accountScope": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "infoHash": "0123456789ABCDEF0123456789ABCDEF01234567",
        "apiKey": "nao-deve-ser-persistida"
    });
    let account = account(&body).unwrap();
    let hash = hash(&body).unwrap();
    assert_eq!(
        submitted_key(account, hash),
        format!(
            "adsub:v1:{}:{}",
            "a".repeat(64),
            "0123456789abcdef0123456789abcdef01234567"
        )
    );
    assert_eq!(
        protect_key(account, hash),
        format!(
            "adprot:v1:alldebrid:{}:{}",
            "a".repeat(64),
            "0123456789abcdef0123456789abcdef01234567"
        )
    );
}

#[test]
fn rejeita_scope_hash_e_ttl_invalidos() {
    assert!(account(&json!({"accountScope":"api-key-raw"})).is_none());
    assert!(hash(&json!({"infoHash":"xyz"})).is_none());
    assert!(ttl(&json!({"ttlSeconds":0}), "ttlSeconds", HOLD_TTL_MAX).is_none());
    assert!(ttl(
        &json!({"ttlSeconds":HOLD_TTL_MAX + 1}),
        "ttlSeconds",
        HOLD_TTL_MAX
    )
    .is_none());
}

#[test]
fn origem_br_precisa_ser_explicitamente_falsa() {
    assert!(!br_origin_proven_non_br(&json!({})));
    assert!(!br_origin_proven_non_br(&json!({"brOrigin":null})));
    assert!(!br_origin_proven_non_br(&json!({"brOrigin":"false"})));
    assert!(!br_origin_proven_non_br(&json!({"brOrigin":true})));
    assert!(br_origin_proven_non_br(&json!({"brOrigin":false})));
}

#[test]
fn mutacoes_de_posse_sao_serializadas() {
    let guard = mutation_lock();
    let (sent, received) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _guard = mutation_lock();
        sent.send(()).unwrap();
    });

    assert!(received
        .recv_timeout(std::time::Duration::from_millis(50))
        .is_err());
    drop(guard);
    received
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("mutação deve prosseguir após soltar o lock");
    worker.join().unwrap();
}

#[test]
fn nome_com_marca_br_veta_adrm_mesmo_com_flag_falso() {
    // O flag `brOrigin` é do chamador; o nome é a evidência que o TS usava.
    assert!(name_has_br_mark(
        &json!({"brOrigin":false,"name":"Filme.2024.1080p.WEB-DL.Dublado.mkv"})
    ));
    assert!(!name_has_br_mark(
        &json!({"name":"Movie.2024.1080p.WEB-DL.x264-GRP.mkv"})
    ));
    assert!(!name_has_br_mark(&json!({})));
}

#[test]
fn sem_kv_a_resposta_e_503_e_nao_400() {
    assert_eq!(unavailable().status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(bad_request("x").status(), StatusCode::BAD_REQUEST);
}
