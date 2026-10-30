use std::sync::Arc;

use adom_debrid::alldebrid::PlayFile;

use crate::dub_audit::{DubAudit, DubAuditConfig};
use crate::dub_audit_fakes::{candidate, hash_of, FakeResolver, FakeWrites};

fn file(path: &str, size: f64) -> PlayFile {
    PlayFile {
        path: path.into(),
        size,
    }
}

fn audit_with(files: Vec<PlayFile>, ok_ttl_ms: i64) -> (Arc<FakeWrites>, DubAudit) {
    let writes = Arc::new(FakeWrites::default());
    let resolver = Arc::new(FakeResolver::new(vec![Ok(()), Ok(())]).with_files(files));
    let config = DubAuditConfig {
        enabled: true,
        tail_max: 2,
        ok_ttl_ms,
    };
    (writes.clone(), DubAudit::new(config, resolver, writes))
}

#[tokio::test]
async fn prova_dublada_e_gravada_e_promove_a_obra() {
    let (writes, dub) = audit_with(vec![file("Filme.2020.1080p.DUAL.mkv", 2e9)], 0);
    let mut cand = candidate(1, None, None);
    cand.needs_promote = true;
    dub.offer(&[cand]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        writes.log(),
        vec![
            format!("file_evidence:{}:Dual", hash_of(1)),
            "invalidate:tt123".to_string(),
        ]
    );
}

#[tokio::test]
async fn prova_sem_rotulo_dublado_grava_mas_nao_invalida() {
    // Cena EN nos arquivos: a prova é gravada (e desmente o claim no build),
    // mas não há promoção a fazer — invalidar só refaria a mesma lista.
    let (writes, dub) = audit_with(vec![file("Filme.2020.1080p.WEB.H264-METCON.mkv", 2e9)], 0);
    let mut cand = candidate(1, None, None);
    cand.needs_promote = true;
    dub.offer(&[cand]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(writes.log(), vec![format!("file_evidence:{}:", hash_of(1))]);
}

#[tokio::test]
async fn ja_dublado_grava_prova_sem_invalidar() {
    let (writes, dub) = audit_with(vec![file("Filme.2020.1080p.DUAL.mkv", 2e9)], 0);
    dub.offer(&[candidate(1, None, None)]);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(
        writes.log(),
        vec![format!("file_evidence:{}:Dual", hash_of(1))]
    );
}

#[tokio::test]
async fn provado_ok_nao_volta_a_fila_dentro_do_prazo() {
    let (_writes, dub) = audit_with(vec![file("Filme.2020.1080p.DUAL.mkv", 2e9)], 60_000);
    assert_eq!(dub.offer(&[candidate(1, None, None)]), 1);
    assert_eq!(dub.drain().await, 1);
    // A próxima busca oferece o mesmo candidato: não gasta outro play real.
    assert_eq!(dub.offer(&[candidate(1, None, None)]), 0);
    // Outra locação do mesmo hash é outra pergunta.
    assert_eq!(dub.offer(&[candidate(1, Some(1), Some(2))]), 1);
}

#[tokio::test]
async fn prazo_zero_desliga_a_memoria() {
    let (_writes, dub) = audit_with(vec![file("Filme.2020.1080p.DUAL.mkv", 2e9)], 0);
    assert_eq!(dub.offer(&[candidate(1, None, None)]), 1);
    assert_eq!(dub.drain().await, 1);
    assert_eq!(dub.offer(&[candidate(1, None, None)]), 1);
}
