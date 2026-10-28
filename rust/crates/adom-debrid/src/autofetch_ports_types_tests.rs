use super::*;
use crate::realdebrid_autofetch::RdAutofetchError;

#[test]
fn escopo_usa_hash_da_conta_e_nunca_a_chave() {
    let scope = scope_of(Service::RealDebrid, "chave-secreta");
    assert!(scope.starts_with("realdebrid:"));
    assert!(!scope.contains("chave-secreta"));
    assert_eq!(Service::DebridLink.id(), "debridlink");
}

#[test]
fn capacidade_desligada_tem_kind_e_texto_proprios() {
    let error = PortError::Unsupported("evict");
    assert_eq!(error.kind(), "unsupported");
    assert_eq!(error.to_string(), "capacidade desligada: evict");

    let error = PortError::InvalidInput("remove sem id de transferência");
    assert_eq!(error.kind(), "invalid_input");
}

#[test]
fn quarentena_do_rd_nao_e_recusa_do_servico() {
    let error = PortError::Rd(RdAutofetchError::Quarantined);
    assert_eq!(error.kind(), "quarantined");
    assert!(error.to_string().contains("quarentena"));

    let error = PortError::Rd(RdAutofetchError::Debrid(DebridError::Quota("teto".into())));
    assert_eq!(error.kind(), "quota");
    assert_eq!(error.to_string(), "real-debrid: teto");
}
