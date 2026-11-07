//! Chave AllDebrid do OPERADOR para as rotinas de fundo (varreduras e foto do
//! inventário) — o `envOperatorAccount` do TS.
//!
//! Não é o `defaults_from_env` do `/resolve`: aquele só herda a chave com
//! `DEBRID_ALLOW_ENV_KEY` (instalação sem `dk` usando a conta do operador). A
//! instância pública sobe `DEBRID_ALLOW_ENV_KEY=false` +
//! `DEBRID_OPERATOR_ENV_ACCOUNT=true`, e com a régua do `/resolve` as
//! varreduras nasciam sem conta ("nada agendado") e a AllDebrid do operador
//! nunca era varrida — medido na VPS em 2026-11-07.

/// Chave do operador se o serviço é AllDebrid, há chave e o uso da conta do
/// operador está ligado. A chave nunca é logada aqui.
pub(crate) fn alldebrid_key_from_env() -> Option<String> {
    let var = |name: &str| std::env::var(name).ok();
    alldebrid_key_from(
        var("DEBRID_SERVICE").as_deref(),
        var("DEBRID_API_KEY").as_deref(),
        var("DEBRID_ALLOW_ENV_KEY").as_deref(),
        var("DEBRID_OPERATOR_ENV_ACCOUNT").as_deref(),
    )
}

fn alldebrid_key_from(
    service: Option<&str>,
    api_key: Option<&str>,
    allow_env_key: Option<&str>,
    operator_env: Option<&str>,
) -> Option<String> {
    let service = service.unwrap_or_default().trim().to_ascii_lowercase();
    let key = api_key.unwrap_or_default().trim();
    // `DEBRID_ALLOW_ENV_KEY` ausente ou vazia vale `true` (mesma leitura do
    // `/resolve` e do `account_catalog`); o `OPERATOR_ENV_ACCOUNT` só com `true`.
    let operator_on = matches!(allow_env_key, None | Some("") | Some("true"))
        || operator_env == Some("true");
    (service == "alldebrid" && !key.is_empty() && operator_on).then(|| key.to_string())
}

#[cfg(test)]
mod tests {
    use super::alldebrid_key_from;

    #[test]
    fn instancia_publica_com_conta_do_operador_ligada_varre() {
        let key = alldebrid_key_from(Some("alldebrid"), Some(" k "), Some("false"), Some("true"));
        assert_eq!(key.as_deref(), Some("k"));
    }

    #[test]
    fn allow_env_key_ausente_ou_true_liga() {
        assert!(alldebrid_key_from(Some("AllDebrid"), Some("k"), None, None).is_some());
        assert!(alldebrid_key_from(Some("alldebrid"), Some("k"), Some(""), None).is_some());
        assert!(alldebrid_key_from(Some("alldebrid"), Some("k"), Some("true"), None).is_some());
    }

    #[test]
    fn os_dois_gates_desligados_nao_varre() {
        assert!(alldebrid_key_from(Some("alldebrid"), Some("k"), Some("false"), None).is_none());
        assert!(
            alldebrid_key_from(Some("alldebrid"), Some("k"), Some("false"), Some("1")).is_none()
        );
    }

    #[test]
    fn outro_servico_ou_sem_chave_nao_varre() {
        assert!(alldebrid_key_from(Some("premiumize"), Some("k"), None, None).is_none());
        assert!(alldebrid_key_from(Some("alldebrid"), Some("  "), None, None).is_none());
        assert!(alldebrid_key_from(None, Some("k"), None, None).is_none());
    }
}
