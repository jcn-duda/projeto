//! Marca `alive` da checagem no magnetdb: a MESMA chave/valor do play, a
//! precedência `bad` reusada do `MagnetStateStore`, filtros (inválido/
//! duplicado), janela desligada e as réguas do env. O `spawn` prova o caminho
//! de produção contra o banco do processo (arquivo temporário) — nenhum teste
//! toca no `data/cache.db` do checkout.

use super::*;
use adom_index::MagnetState;

const KEY: &str = "chave-da-conta-alive";
const KEY_OFF: &str = "chave-da-conta-alive-off";
const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 86_400;
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HIT2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BAD: &str = "cccccccccccccccccccccccccccccccccccccccc";

struct EnvGuard {
    prev: Vec<(&'static str, Option<String>)>,
    // Trava ÚNICA do crate: outros módulos de teste também mexem na env.
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let lock = crate::test_env::lock();
        let mut prev = Vec::new();
        for (name, value) in pairs {
            prev.push((*name, std::env::var(name).ok()));
            // SAFETY: a trava única serializa os testes; a env só aponta
            // kill-switch e TTL da marca.
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
        // SAFETY: restauração dos valores guardados no set, com a trava
        // ainda segura pelo próprio guard.
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

fn store() -> MagnetStateStore {
    MagnetStateStore::open_memory().expect("magnetdb em memória")
}

/// Lote de hashes como o veredito entrega (`Vec<String>`), a partir de &str.
fn lote(hashes: &[&str]) -> Vec<String> {
    hashes.iter().map(|hash| (*hash).to_string()).collect()
}

fn agora() -> i64 {
    crate::error::now_ms() as i64
}

/// Espera que a leitura do store devolva o estado pedido (teto de ~2 s): a
/// gravação do `spawn` roda em `spawn_blocking`.
async fn wait_state(
    mag: &MagnetStateStore,
    service: &str,
    api_key: &str,
    hash: &str,
    now: i64,
) -> Option<MagnetState> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let state = mag.state(service, api_key, hash, now).unwrap();
        if state.is_some() || std::time::Instant::now() >= deadline {
            return state;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[test]
fn grava_alive_com_a_mesma_chave_do_play() {
    let mag = store();
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", KEY, &lote(&[HIT]), 7 * DAY, NOW),
        1
    );
    // A MESMA chave do play: `mag:v1:alive:<serviço>:<escopo>:<hash>` — a
    // leitura pública do store (que monta a chave por `magnet_key`) prova o
    // escopo da conta, o campo e o valor vivo.
    assert_eq!(
        mag.state("premiumize", KEY, HIT, NOW).unwrap(),
        Some(MagnetState::Alive)
    );
    // Renovação da chave viva não conta nascimento (régua do `mark_alive`).
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", KEY, &lote(&[HIT]), 7 * DAY, NOW),
        0
    );
}

#[test]
fn bad_vivo_nao_renasce_alive() {
    let mag = store();
    assert!(mag.mark_bad("torbox", KEY, BAD, DAY, NOW).unwrap());
    let born = mark_alive_batch(&mag, "torbox", KEY, &lote(&[BAD, HIT2]), 7 * DAY, NOW);
    assert_eq!(born, 1, "só o hash sem `bad` renasce");
    assert_eq!(
        mag.state("torbox", KEY, BAD, NOW).unwrap(),
        Some(MagnetState::Bad),
        "o play provou que está quebrado: a checagem não ressuscita"
    );
    assert_eq!(
        mag.state("torbox", KEY, HIT2, NOW).unwrap(),
        Some(MagnetState::Alive)
    );
}

#[test]
fn lote_normaliza_e_dedupa_e_ignora_lixo() {
    let mag = store();
    let maiusculas = HIT.to_uppercase();
    let com_espaco = format!("  {HIT2}  ");
    let bruto = vec![
        maiusculas,
        com_espaco,
        HIT.to_string(),
        "nao-e-hash".into(),
        "".into(),
    ];
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", KEY, &bruto, DAY, NOW),
        2,
        "só os dois hashes válidos do lote"
    );
    assert_eq!(
        mag.state("premiumize", KEY, HIT, NOW).unwrap(),
        Some(MagnetState::Alive)
    );
    assert_eq!(
        mag.state("premiumize", KEY, HIT2, NOW).unwrap(),
        Some(MagnetState::Alive)
    );
}

#[test]
fn janela_desligada_nao_grava_nada() {
    let mag = store();
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", KEY, &lote(&[HIT]), 0, NOW),
        0
    );
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", KEY, &lote(&[HIT]), -5, NOW),
        0
    );
    assert_eq!(mag.state("premiumize", KEY, HIT, NOW).unwrap(), None);
}

#[test]
fn servico_ou_conta_vazios_nao_gravam() {
    let mag = store();
    assert_eq!(mark_alive_batch(&mag, "", KEY, &lote(&[HIT]), DAY, NOW), 0);
    assert_eq!(
        mark_alive_batch(&mag, "premiumize", "  ", &lote(&[HIT]), DAY, NOW),
        0
    );
}

#[test]
fn magnet_db_desligado_pelo_kill_switch() {
    {
        let _env = EnvGuard::set(&[("MAGNET_DB", None), ("MAGNET_ALIVE_TTL", None)]);
        assert!(magnet_db_enabled(), "não setado = default ligado");
        assert_eq!(alive_ttl_seconds(), 604_800, "default de 7 dias");
        assert!(enabled());
    }
    {
        let _env = EnvGuard::set(&[("MAGNET_DB", Some("false"))]);
        assert!(!magnet_db_enabled(), "kill-switch do magnetdb manda");
        assert!(!enabled());
    }
    {
        let _env = EnvGuard::set(&[("MAGNET_DB", None), ("MAGNET_ALIVE_TTL", Some("0"))]);
        assert_eq!(alive_ttl_seconds(), 0, "janela zero desliga");
        assert!(
            !enabled(),
            "TTL 0 desliga a marca mesmo com o switch ligado"
        );
    }
    {
        let _env = EnvGuard::set(&[
            ("MAGNET_DB", Some("true")),
            ("MAGNET_ALIVE_TTL", Some("3600")),
        ]);
        assert_eq!(alive_ttl_seconds(), 3_600, "env manda quando setado");
        assert!(enabled());
    }
}

#[tokio::test]
async fn spawn_grava_no_magnetdb_do_processo() {
    let _env = EnvGuard::set(&[("MAGNET_DB", None), ("MAGNET_ALIVE_TTL", None)]);
    spawn("premiumize", KEY, &lote(&[HIT]));
    // Segunda conexão SÓ de leitura sobre o arquivo PRÓPRIO da marca: é o
    // mesmo banco que o `spawn_blocking` escreve.
    let mag = MagnetStateStore::open(std::path::Path::new(&cache_db_path())).unwrap();
    let state = wait_state(&mag, "premiumize", KEY, HIT, agora()).await;
    assert_eq!(state, Some(MagnetState::Alive), "spawn gravou a marca");
}

#[tokio::test]
async fn spawn_com_magnet_db_off_nao_grava() {
    let _env = EnvGuard::set(&[("MAGNET_DB", Some("false"))]);
    spawn("premiumize", KEY_OFF, &lote(&[HIT2]));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let mag = MagnetStateStore::open(std::path::Path::new(&cache_db_path())).unwrap();
    assert_eq!(
        mag.state("premiumize", KEY_OFF, HIT2, agora()).unwrap(),
        None,
        "kill-switch desliga a marca de ponta a ponta"
    );
}
