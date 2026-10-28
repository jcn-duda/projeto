//! Guardas do espelho do contrato: forma dos dados, `Send` do futuro e o
//! candidato mínimo que a porta aceita.

use super::*;

fn assert_send<T: Send>(_: &T) {}

#[test]
fn futuro_do_contrato_exige_send() {
    // O worker roda em tokio multi-thread: um futuro que não é `Send` não
    // compila lá, então a barreira é conferida aqui.
    let future: DebridFuture<'static, CacheEvidence, ()> = Box::pin(async {
        Ok(CacheEvidence {
            known: false,
            cached: Vec::new(),
        })
    });
    assert_send(&future);
}

#[test]
fn candidato_da_porta_leva_so_identidade_e_dica() {
    let candidate = PortCandidate::new("ABCD")
        .with_season_episode(Some(1), Some(2))
        .with_dubbed(true);
    assert_eq!(candidate.hash, "ABCD");
    assert_eq!(candidate.season, Some(1));
    assert_eq!(candidate.episode, Some(2));
    assert!(candidate.dubbed);

    // Padrão é hash vazio e sem dica: a porta recusa antes de qualquer I/O.
    assert_eq!(PortCandidate::default().hash, "");
    assert!(!PortCandidate::default().dubbed);
}

#[test]
fn evidencia_de_conta_nao_inventa_ocupacao() {
    let unknown = AccountEvidence {
        used: None,
        max: None,
    };
    assert_eq!(unknown.used, None);
    assert_ne!(unknown.used, Some(0));
}
