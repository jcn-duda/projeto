//! Testes do wiring de rede do resolver: nome do operador → perfil do registry.

use super::*;

/// O nome do operador (`torrentgalaxy`) acha o perfil `torrentgalaxy-cardigann`
/// pelo sufixo — é o que amarra o resolver da porta 8708 ao registry do crawl.
#[test]
fn torrentgalaxy_acha_perfil_pelo_nome_do_operador() {
    let found = lookup_site_config("torrentgalaxy").expect("perfil do TGx");
    assert_eq!(found.site_id, "torrentgalaxy-cardigann");
    assert!(found
        .candidate_hosts
        .contains(&"torrentgalaxy.one".to_string()));
    assert!(found
        .candidate_hosts
        .contains(&"torrentgalaxy.info".to_string()));
}

/// O espelho `.info` entra como candidato DEPOIS da URL do operador: failover
/// de domínio sem inverter a ordem do primário.
#[test]
fn candidatos_trazem_o_espelho_depois_do_primario() {
    let network = network_config_for("torrentgalaxy");
    let candidates = build_candidates("https://torrentgalaxy.one", &[], &network);
    assert_eq!(candidates[0], "https://torrentgalaxy.one");
    assert!(
        candidates.iter().any(|c| c.contains("torrentgalaxy.info")),
        "o espelho do registry precisa entrar como candidato de failover"
    );
}

/// Site sem perfil no registry cai no default — o resolver não quebra nem
/// fica sem prazo nem User-Agent.
#[test]
fn site_desconhecido_cai_no_default() {
    let config = network_config_for("site-que-nao-existe");
    assert_eq!(config.site_id, "site-que-nao-existe");
    assert_eq!(config.timeout_ms, 15_000);
    assert!(!config.uses_flare);
    assert!(!config.user_agent.is_empty());
}
