//! Testes do interrogatório de áudio (T3-L7a) sem disco, sem rede e sem debrid:
//! resolver e escritas são falsos, mas as REGRAS são as de produção.

use std::sync::Arc;

use adom_debrid::DebridError;
use serde_json::json;

use super::*;
use crate::dub_audit_fakes::*;

#[test]
fn offer_dedupe_por_conta_hash_temporada_e_episodio() {
    let writes = Arc::new(FakeWrites::default());
    let (_resolver, dub) = audit(vec![], writes, 2, false);
    assert_eq!(dub.offer(&[candidate(1, Some(1), Some(4))]), 1);
    // Mesmo hash/S/E: é a mesma pergunta.
    assert_eq!(dub.offer(&[candidate(1, Some(1), Some(4))]), 0);
    // Outra temporada/episódio é outra pergunta.
    assert_eq!(dub.offer(&[candidate(1, Some(2), Some(4))]), 1);
    // Outra CONTA (chave) é outra pergunta: o veredito é por conta.
    let mut other = candidate(1, Some(1), Some(4));
    other.api_key = "chave-b".into();
    assert_eq!(dub.offer(&[other]), 1);
    assert_eq!(dub.pending(), 3);
}

#[test]
fn offer_respeita_o_teto_de_cinquenta() {
    let writes = Arc::new(FakeWrites::default());
    let (_resolver, dub) = audit(vec![], writes, 4, false);
    let batch: Vec<Candidate> = (0..60u8)
        .map(|seed| candidate(seed % 6, Some(1), Some(i64::from(seed))))
        .collect();
    dub.offer(&batch);
    assert_eq!(dub.pending(), PENDING_CAP);
}

#[test]
fn offer_nao_gasta_consulta_ja_condenada() {
    let hash = hash_of(1);
    let writes = Arc::new(FakeWrites::with_lie("alldebrid", "chave-a", &hash));
    writes.with_missing("tt123", 1, 9, &hash_of(2));
    let (_resolver, dub) = audit(vec![], writes, 2, false);
    assert_eq!(
        dub.offer(&[
            candidate(1, Some(1), Some(4)),
            candidate(2, Some(1), Some(9))
        ]),
        0
    );
    assert_eq!(dub.pending(), 0);
}

#[test]
fn config_desligada_nao_enfileira() {
    let writes = Arc::new(FakeWrites::default());
    let config = DubAuditConfig {
        enabled: false,
        tail_max: 2,
    };
    let dub = DubAudit::new(config, Arc::new(FakeResolver::new(vec![])), writes);
    assert_eq!(dub.offer(&[candidate(1, Some(1), Some(4))]), 0);
    assert_eq!(dub.pending(), 0);
}

#[tokio::test]
async fn drain_um_por_vez_e_respeita_o_teto_do_tail() {
    let writes = Arc::new(FakeWrites::default());
    let (resolver, dub) = audit(vec![], writes, 2, true);
    dub.offer(&[
        candidate(1, Some(1), Some(4)),
        candidate(2, Some(1), Some(4)),
        candidate(3, Some(1), Some(4)),
    ]);
    // Duas drenagens concorrentes: só uma roda; a outra volta com 0.
    let (first, second) = tokio::join!(dub.drain(), dub.drain());
    assert_eq!(first + second, 2);
    assert_eq!(resolver.calls().len(), 2);
    assert_eq!(dub.pending(), 1);
}

#[tokio::test]
async fn interrogatorio_usa_a_conta_e_os_dados_do_candidato() {
    let writes = Arc::new(FakeWrites::default());
    let (resolver, dub) = audit(vec![Ok(())], writes, 2, false);
    let mut cand = candidate(1, Some(2), Some(7));
    cand.work = work(&["minha serie"], Some(2020), true);
    dub.offer(&[cand]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        resolver.calls()[0],
        Call {
            service: "alldebrid".into(),
            api_key: "chave-a".into(),
            hash: hash_of(1),
            season: Some(2),
            episode: Some(7),
            dubbed: true,
            // O interrogatório não é play: nunca segura o frio.
            held: false,
        }
    );
}

#[tokio::test]
async fn mentira_grava_o_mesmo_veredito_do_play() {
    let writes = Arc::new(FakeWrites::default());
    let lie = DebridError::DubLie {
        message: "conteúdo em inglês".into(),
        evidence: Some(evidence(vec![4])),
        context: None,
    };
    let (_resolver, dub) = audit(vec![Err(lie)], writes.clone(), 2, false);
    dub.offer(&[candidate(1, Some(1), Some(4))]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        writes.log(),
        vec![
            format!("mark_lie:alldebrid:chave-a:{}", hash_of(1)),
            format!("unprotect:alldebrid:chave-a:{}", hash_of(1)),
            format!("mark_lied:tt123:1:4:{}", hash_of(1)),
            "invalidate:tt123".to_string(),
        ]
    );
}

#[tokio::test]
async fn episodio_errado_com_prova_marca_o_episodio() {
    let writes = Arc::new(FakeWrites::default());
    let pick = DebridError::EpisodePick {
        message: "episódio errado".into(),
        evidence: Some(evidence(vec![7])),
        context: None,
    };
    let (_resolver, dub) = audit(vec![Err(pick)], writes.clone(), 2, false);
    dub.offer(&[candidate(1, Some(1), Some(4))]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        writes.log(),
        vec![
            format!("mark_missing:tt123:1:4:{}:false", hash_of(1)),
            "invalidate:tt123".to_string(),
        ]
    );
}

#[tokio::test]
async fn episodio_sem_episodios_declarados_marca_a_temporada() {
    let writes = Arc::new(FakeWrites::default());
    let pick = DebridError::EpisodePick {
        message: "pack sem episódio".into(),
        evidence: Some(evidence(vec![])),
        context: None,
    };
    let (_resolver, dub) = audit(vec![Err(pick)], writes.clone(), 2, false);
    dub.offer(&[candidate(1, Some(1), Some(4))]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        writes.log(),
        vec![
            format!("mark_missing:tt123:1:4:{}:true", hash_of(1)),
            "invalidate:tt123".to_string(),
        ]
    );
}

#[tokio::test]
async fn ambiguidade_sem_prova_nao_grava_nada() {
    let writes = Arc::new(FakeWrites::default());
    let pick = DebridError::EpisodePick {
        message: "não identifiquei".into(),
        evidence: None,
        context: None,
    };
    let (_resolver, dub) = audit(vec![Err(pick)], writes.clone(), 2, false);
    dub.offer(&[candidate(1, Some(1), Some(4))]);
    assert_eq!(dub.drain().await, 1);
    assert!(writes.log().is_empty());
}

#[tokio::test]
async fn erro_de_rede_nao_grava_e_o_candidato_volta_depois() {
    let writes = Arc::new(FakeWrites::default());
    let (_resolver, dub) = audit(
        vec![Err(DebridError::other("timeout"))],
        writes.clone(),
        2,
        false,
    );
    dub.offer(&[candidate(1, Some(1), Some(4))]);
    assert_eq!(dub.drain().await, 1);
    assert!(writes.log().is_empty());
    // Nada foi condenado: a próxima busca oferece o mesmo hash de novo.
    assert_eq!(dub.offer(&[candidate(1, Some(1), Some(4))]), 1);
}

#[tokio::test]
async fn sucesso_de_claim_sem_prova_promove_a_obra() {
    let writes = Arc::new(FakeWrites::default());
    let (_resolver, dub) = audit(vec![Ok(())], writes.clone(), 2, false);
    let mut cand = candidate(1, Some(1), Some(4));
    cand.needs_promote = true;
    dub.offer(&[cand]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(writes.log(), vec!["invalidate:tt123".to_string()]);
}

#[test]
fn parse_effect_le_o_payload_do_efeito() {
    let payload: Map<String, Value> = serde_json::from_value(json!({
        "adapter_id": "alldebrid",
        "api_key": "chave-a",
        "search_key": "qualquer",
        "candidates": [{
            "hash": "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            "season": 1,
            "episode": 4,
            "imdbId": "tt123",
            "work": { "names": ["nome"], "year": 2020, "pack": true },
            "dubbed": true,
            "needsPromote": true
        }]
    }))
    .unwrap();
    let (adapter, api_key, candidates) = parse_effect(&payload).expect("payload válido");
    assert_eq!(adapter, "alldebrid");
    assert_eq!(api_key, "chave-a");
    assert_eq!(
        candidates[0],
        Candidate {
            adapter: "alldebrid".into(),
            api_key: "chave-a".into(),
            hash: "abcdef0123456789abcdef0123456789abcdef01".into(),
            season: Some(1),
            episode: Some(4),
            imdb_id: Some("tt123".into()),
            work: work(&["nome"], Some(2020), true),
            dubbed: true,
            needs_promote: true,
        }
    );
}

#[test]
fn parse_effect_recusa_forma_que_nao_serve() {
    let bad_hash: Map<String, Value> = serde_json::from_value(json!({
        "adapter_id": "alldebrid",
        "api_key": "chave-a",
        "candidates": [{ "hash": "curto" }]
    }))
    .unwrap();
    assert!(parse_effect(&bad_hash).is_none());
    let no_key: Map<String, Value> = serde_json::from_value(json!({
        "adapter_id": "alldebrid",
        "api_key": "",
        "candidates": []
    }))
    .unwrap();
    assert!(parse_effect(&no_key).is_none());
    let no_candidates: Map<String, Value> = serde_json::from_value(json!({
        "adapter_id": "alldebrid",
        "api_key": "chave-a"
    }))
    .unwrap();
    assert!(parse_effect(&no_candidates).is_none());
}
