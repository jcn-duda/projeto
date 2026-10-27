//! Dono ÚNICO da marca de POSSE do upload do autofetch.
//!
//! No Node, o `rememberSubmitted` grava o hash logo depois do aceite do upload
//! e o `dropUncached` consulta a marca: o que ESTA instância subiu não é acervo
//! do usuário e pode sair. No Rust a marca morava solta em
//! `cleanup_holds::remember_submitted` e a regra em `should_mark_owned`; aqui
//! as duas ficam atrás de uma porta só, para o worker nativo não repetir
//! `accepted && New` em cada chamador — nem esquecer a normalização do hash
//! (a AllDebrid devolve o hash em caixa alta em alguns caminhos).
//!
//! É memória do PROCESSO: nada de KV nem de HTTP. O registro durável (`adsub`)
//! continua sendo escrito pelo Node; um restart zera esta marca e o inventário
//! seguinte trata os hashes como acervo do usuário (fail-safe: ninguém apaga).

use crate::alldebrid::{should_mark_owned, Provenance};
use crate::alldebrid_cleanup::{remember_submitted, submitted_hashes};

/// Marca o hash como subido por nós — SÓ quando o upload foi aceito e o
/// snapshot anterior prova que ele não estava na conta (proveniência `New`).
///
/// Devolve `true` apenas quando a marca foi feita; conta/hash vazio ou
/// proveniência incerta (`Preexisting`/`Unavailable`) devolvem `false` sem
/// tocar no registro. `accepted` é o veredito do upload, não o status do
/// torrent: recusado nunca marca.
pub fn mark_owned(account: &str, hash: &str, accepted: bool, provenance: Provenance) -> bool {
    if account.trim().is_empty() || hash.trim().is_empty() {
        return false;
    }
    if !should_mark_owned(accepted, provenance) {
        return false;
    }
    // `Submitted::remember` já faz trim + lower-case; o lower-case explícito
    // mantém o contrato do TS (`rememberSubmitted(account, hash.toLowerCase())`)
    // e deixa a intenção visível para quem lê a chamada.
    remember_submitted(account, &hash.to_lowercase());
    true
}

/// O hash já está marcado como nosso nesta instância. Consulta pura, para
/// diagnóstico e teste do worker (o delete não depende dela aqui).
pub fn owns(account: &str, hash: &str) -> bool {
    let hash = hash.trim().to_lowercase();
    !hash.is_empty() && submitted_hashes(account).contains(&hash)
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use super::{mark_owned, owns};
    use crate::alldebrid::Provenance;
    use crate::alldebrid_cleanup::reset_submitted;

    /// `submitted` é um mapa global do processo e o harness roda os testes em
    /// paralelo: sem a trava, o `reset_submitted` de um teste apagaria a marca
    /// que o outro acabou de gravar, no meio do assert.
    fn lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    const ACCOUNT: &str = "ad-owned-test";

    fn hash(ch: char) -> String {
        ch.to_string().repeat(40)
    }

    #[test]
    fn aceito_e_novo_marca() {
        let _guard = lock();
        reset_submitted();
        assert!(mark_owned(ACCOUNT, &hash('a'), true, Provenance::New));
        assert!(owns(ACCOUNT, &hash('a')));
        reset_submitted();
    }

    #[test]
    fn aceito_e_preexistente_nao_marca() {
        let _guard = lock();
        reset_submitted();
        assert!(!mark_owned(
            ACCOUNT,
            &hash('b'),
            true,
            Provenance::Preexisting
        ));
        assert!(!owns(ACCOUNT, &hash('b')));
        reset_submitted();
    }

    #[test]
    fn aceito_e_indisponivel_nao_marca() {
        let _guard = lock();
        reset_submitted();
        assert!(!mark_owned(
            ACCOUNT,
            &hash('c'),
            true,
            Provenance::Unavailable
        ));
        assert!(!owns(ACCOUNT, &hash('c')));
        reset_submitted();
    }

    #[test]
    fn recusado_e_novo_nao_marca() {
        let _guard = lock();
        reset_submitted();
        assert!(!mark_owned(ACCOUNT, &hash('d'), false, Provenance::New));
        assert!(!owns(ACCOUNT, &hash('d')));
        reset_submitted();
    }

    #[test]
    fn hash_maiusculo_normaliza() {
        let _guard = lock();
        reset_submitted();
        let upper = hash('E');
        assert!(mark_owned(ACCOUNT, &upper, true, Provenance::New));
        assert!(owns(ACCOUNT, &hash('e')), "guardado em minúsculas");
        assert!(owns(ACCOUNT, &upper), "a consulta normaliza também");
        reset_submitted();
    }

    #[test]
    fn conta_ou_hash_vazio_nao_marca() {
        let _guard = lock();
        reset_submitted();
        assert!(!mark_owned("", &hash('f'), true, Provenance::New));
        assert!(!mark_owned("   ", &hash('f'), true, Provenance::New));
        assert!(!mark_owned(ACCOUNT, "", true, Provenance::New));
        assert!(!mark_owned(ACCOUNT, "   ", true, Provenance::New));
        assert!(!owns(ACCOUNT, &hash('f')), "nada foi marcado");
        assert!(!owns("", &hash('f')));
        assert!(!owns(ACCOUNT, ""));
        reset_submitted();
    }
}
