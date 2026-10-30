//! Feed de holds: cobertura fail-closed do lote, normalização dos conjuntos e o
//! gate da flag `DEBRID_AL_HOLDS`. Sem rede: os fatos são montados em memória
//! (a rota Node que os entregava saiu; quem calcula é o gateway).

use super::HoldsFacts;

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
fn conjuntos_saem_em_minusculas_sem_vazios() {
    let parsed = HoldsFacts {
        known_before: vec![HIT.to_uppercase(), "  ".into()],
        held: vec![MISS.to_uppercase(), MISS.to_string()],
        ..HoldsFacts::default()
    };
    assert_eq!(parsed.known_before_set().len(), 1);
    assert!(parsed.known_before_set().contains(HIT));
    assert_eq!(
        parsed.held_set().len(),
        1,
        "duplicata de caixa vira um hash"
    );
    assert!(parsed.held_set().contains(MISS));
}

#[test]
fn flag_default_off_e_apelidos() {
    {
        let _env = EnvGuard::set(&[(super::ENV, None)]);
        assert!(!super::holds_feed_enabled());
    }
    for raw in ["on", "1", "true", "yes", "RUST"] {
        let _env = EnvGuard::set(&[(super::ENV, Some(raw))]);
        assert!(super::holds_feed_enabled(), "{raw}");
    }
    let _env = EnvGuard::set(&[(super::ENV, Some("off"))]);
    assert!(!super::holds_feed_enabled());
}
