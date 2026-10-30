use super::*;
use serde_json::json;

#[test]
fn allow_env_key_so_com_true_exato() {
    // `String(env || 'true') === 'true'`: vazio/ausente herda (true), mas
    // `1`/`false`/`TRUE` desligam a herança.
    assert!(allow_env_key_from(None));
    assert!(allow_env_key_from(Some("")));
    assert!(allow_env_key_from(Some("true")));
    assert!(!allow_env_key_from(Some("1")));
    assert!(!allow_env_key_from(Some("false")));
    assert!(!allow_env_key_from(Some("TRUE")));
}

#[test]
fn config_da_url_sobrepoe_o_default_do_operador() {
    let defaults = json!({"debridService":"alldebrid","debridApiKey":"chave-env"});
    let encoded = adom_core::encode_config(&json!({"ds":"torbox","dk":"chave-url"}));
    let config = debrid_config(Some(&encoded), "", &defaults).unwrap();
    assert_eq!(config.service, "torbox");
    assert_eq!(config.api_key, "chave-url");
    // Sem segmento, herda o default (mesmo `runtime.decode(null)` do Node).
    let config = debrid_config(None, "", &defaults).unwrap();
    assert_eq!(config.service, "alldebrid");
    assert_eq!(config.api_key, "chave-env");
    // Segmento inválido é 404, não config forjada.
    assert!(debrid_config(Some("não-é-base64!"), "", &defaults).is_err());
}

#[test]
fn sem_servico_ou_chave_nao_ha_adaptador() {
    assert!(!DebridConfig::default().has_adapter());
    assert!(!DebridConfig {
        service: "premiumize".into(),
        api_key: String::new(),
    }
    .has_adapter());
    assert!(!DebridConfig {
        service: "stremthru".into(),
        api_key: "k".into(),
    }
    .has_adapter());
    assert!(DebridConfig {
        service: "premiumize".into(),
        api_key: "k".into(),
    }
    .has_adapter());
}
