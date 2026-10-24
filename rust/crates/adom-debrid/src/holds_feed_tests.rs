//! Feed de holds: parsing estrito, cobertura fail-closed, contrato do POST
//! (token no header, `encoded`/`service`/`hashes` no corpo, sem apiKey) e o
//! gate da flag. Servidor falso em loopback; sem rede real.

use serde_json::json;

use super::{parse_holds_response, HoldsFacts};

const TOKEN: &str = "token-interno-holds";
const ENCODED: &str = "eyJwIjoiamFja2V0dCJ9";
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MISS: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACCOUNT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Env com a trava única do crate (outros módulos de teste também mexem).
struct EnvGuard {
    prev: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let lock = crate::test_env::lock();
        let mut prev = Vec::new();
        for (name, value) in pairs {
            prev.push((*name, std::env::var(name).ok()));
            unsafe {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
        Self { prev, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            for (name, value) in &self.prev {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

fn facts(complete: bool, evaluated: &[&str], held: &[&str]) -> HoldsFacts {
    HoldsFacts {
        account: ACCOUNT.into(),
        inventory_loaded: true,
        known_before: vec![HIT.into()],
        held: held.iter().map(|h| (*h).to_string()).collect(),
        evaluated: evaluated.iter().map(|h| (*h).to_string()).collect(),
        holds_complete: complete,
        drop_ready: Some(true),
        drop_uncached: Some(false),
    }
}

#[test]
fn covers_exige_prova_de_avaliacao_do_lote() {
    let batch = vec![HIT.to_string(), MISS.to_string()];
    assert!(facts(true, &[HIT, MISS], &[]).covers(&batch));
    let upper = MISS.to_uppercase();
    assert!(
        facts(true, &[HIT, upper.as_str()], &[]).covers(&batch),
        "casing não importa"
    );
    assert!(
        !facts(false, &[HIT, MISS], &[]).covers(&batch),
        "holdsComplete:false nunca cobre"
    );
    assert!(
        !facts(true, &[HIT], &[]).covers(&batch),
        "evaluated sem um hash do lote não prova cobertura"
    );
    assert!(
        !facts(true, &[HIT, MISS], &[]).covers(&[String::new()]),
        "hash vazio no lote derruba a prova"
    );
    assert!(
        !facts(true, &[HIT, MISS], &[]).covers(&[]),
        "lote vazio não prova nada"
    );
    let mut no_account = facts(true, &[HIT], &[]);
    no_account.account.clear();
    assert!(
        !no_account.covers(&[HIT.to_string()]),
        "sem identidade de conta não há prova"
    );
    // A lista de protegidos não precisa estar em `evaluated` para cobrir (ela
    // só protege mais); o que importa é a avaliação do lote.
    assert!(facts(true, &[HIT, MISS], &[MISS]).covers(&batch));
}

#[test]
fn parse_aceita_contrato_completo() {
    let parsed = parse_holds_response(&json!({
        "ok": true,
        "service": "alldebrid",
        "account": ACCOUNT,
        "inventoryLoaded": true,
        "knownBefore": [HIT],
        "heldHashes": [MISS],
        "evaluated": [HIT, MISS],
        "holdsComplete": true,
        "dropReady": true,
        "dropUncached": false,
    }))
    .unwrap();
    assert_eq!(parsed.account, ACCOUNT);
    assert!(parsed.inventory_loaded);
    assert!(parsed.holds_complete);
    assert_eq!(parsed.known_before, vec![HIT]);
    assert_eq!(parsed.held, vec![MISS]);
    assert_eq!(parsed.evaluated.len(), 2);
    assert_eq!(parsed.drop_ready, Some(true));
    assert_eq!(parsed.drop_uncached, Some(false));
    assert!(parsed.covers(&[HIT.to_string(), MISS.to_string()]));
    assert_eq!(parsed.known_before_set().len(), 1);
    assert_eq!(parsed.held_set().len(), 1);

    // Flags ausentes ficam `None` (o `verdict` usa o default do ambiente).
    let without_drops = parse_holds_response(&json!({
        "ok": true,
        "service": "alldebrid",
        "account": ACCOUNT,
        "inventoryLoaded": false,
        "knownBefore": [],
        "heldHashes": [],
        "evaluated": [HIT],
        "holdsComplete": true,
    }))
    .unwrap();
    assert_eq!(without_drops.drop_ready, None);
    assert_eq!(without_drops.drop_uncached, None);
}

#[test]
fn parse_recusa_corpo_que_nao_prova_nada() {
    // `ok:false` → erro com a mensagem do Node.
    let err = parse_holds_response(&json!({ "ok": false, "error": "boom" })).unwrap_err();
    assert_eq!(err, "boom");
    // Serviço errado não é feed de holds.
    let err = parse_holds_response(&json!({
        "ok": true, "service": "torbox", "account": ACCOUNT,
        "inventoryLoaded": false, "knownBefore": [], "heldHashes": [],
        "evaluated": [HIT], "holdsComplete": true,
    }))
    .unwrap_err();
    assert!(err.contains("serviço inesperado"), "{err}");
    // Sem `evaluated` (Node antigo) NÃO autoriza: é erro, não "completo".
    for key in [
        "service",
        "account",
        "inventoryLoaded",
        "holdsComplete",
        "knownBefore",
        "heldHashes",
        "evaluated",
    ] {
        let mut body = json!({
            "ok": true,
            "service": "alldebrid",
            "account": ACCOUNT,
            "inventoryLoaded": true,
            "knownBefore": [HIT],
            "heldHashes": [],
            "evaluated": [HIT],
            "holdsComplete": true,
        });
        body.as_object_mut().unwrap().remove(key);
        assert!(
            parse_holds_response(&body).is_err(),
            "sem {key} o feed não pode ser aceito"
        );
    }
    // Lista com item não textual é corpo estranho.
    assert!(parse_holds_response(&json!({
        "ok": true,
        "service": "alldebrid",
        "account": ACCOUNT,
        "inventoryLoaded": true,
        "knownBefore": [],
        "heldHashes": [],
        "evaluated": [1],
        "holdsComplete": true,
    }))
    .is_err());
}

#[path = "holds_feed_tests_part2.rs"]
mod part2;
