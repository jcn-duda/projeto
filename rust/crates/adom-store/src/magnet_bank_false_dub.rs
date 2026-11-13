//! Reparo ÚNICO do falso dublado no acervo (`magnets.db`).
//!
//! O parser do Torrentio lia a linha só de bandeiras (`🇬🇧 / 🇵🇹 / 🇪🇸 / …`, a
//! lista de faixas/legendas da release de cena) como áudio PT e colava uma
//! linha `PT-BR` no título (corrigido em `0e2122a3`). A captura classificou
//! essas releases globais como `dubbed = 1`, e o `dubbed` do acervo só sobe
//! (OR-merge): sem este reparo a marca errada ficava para sempre. Medido na
//! produção em 2026-11-13: 429 linhas `is_br = 0, dubbed = 1`, ~225 sem
//! nenhuma marca PT no título (Batman: Knightfall, Heart of the Beast…).
//!
//! Régua (só linha GLOBAL, `is_br = 0`, com `dubbed = 1`):
//! - tira do título a linha exata `PT-BR` que o parser injetava e a linha de
//!   idiomas crua (`Dubbed / Multi Subs / 🇬🇧 / 🇵🇹`) de parsers mais antigos;
//! - a linha crua com rótulo de ÁUDIO + 🇵🇹 e sem `Multi Subs` prova PT (a
//!   mesma régua do parser corrigido) e a linha fica;
//! - senão, fica só se o resto prova PT pelo núcleo: `explicit_pt_audio` ou
//!   `looks_pt_br` (Dublado/Nacional, ou Dual COM sinal de português — o
//!   "Coração Selvagem … DUAL" do BluDV fica, o anime "Dual Audio" JA+EN sai);
//! - o resto perde `dubbed` e as duas linhas.
//!
//! Falso negativo aqui se cura sozinho: a próxima captura de um hash dublado de
//! verdade volta a marcar (`dubbed` só sobe). Linha BR (`is_br = 1`) não é
//! tocada. O marcador em `magnet_meta` impede que rode de novo; falha não grava
//! o marcador (tenta no próximo boot).

use adom_core::{explicit_pt_audio, looks_pt_br};
use rusqlite::{params, OptionalExtension};

use super::super::MagnetBankStore;

const MARK: &str = "repair:false-dub-torrentio-flags-v1";
/// Linha que o parser antigo do Torrentio colava no título.
const INJECTED_LINE: &str = "PT-BR";

/// Bandeira emoji: par de indicadores regionais (VS16 opcional).
fn is_flag(token: &str) -> bool {
    let mut regional = 0;
    for c in token.chars() {
        match c {
            '\u{1F1E6}'..='\u{1F1FF}' => regional += 1,
            '\u{FE0F}' => {}
            _ => return false,
        }
    }
    regional == 2
}

/// Linha de idiomas do Torrentio gravada CRUA por parsers antigos
/// (`Dubbed / Multi Subs / … / 🇵🇹`): `None` se não é uma; `Some(prova)` com a
/// MESMA régua do parser corrigido — bandeira PT só vale com rótulo de áudio e
/// sem `Multi Subs`.
fn language_line_proves_pt(line: &str) -> Option<bool> {
    let tokens: Vec<&str> = line.split('/').map(str::trim).collect();
    if tokens.len() < 2 || tokens.iter().any(|t| t.is_empty()) {
        return None;
    }
    let (mut pt_flag, mut audio, mut subs) = (false, false, false);
    for token in &tokens {
        match token.to_lowercase().as_str() {
            "dubbed" | "dual audio" | "multi audio" => audio = true,
            "multi subs" => subs = true,
            _ if is_flag(token) => pt_flag |= *token == "🇵🇹" || *token == "🇧🇷",
            _ => return None,
        }
    }
    Some(pt_flag && audio && !subs)
}

/// Título sem a linha injetada e sem a linha de idiomas crua; `None` quando a
/// linha deve manter o `dubbed`.
pub(crate) fn false_dub_title(title: &str) -> Option<String> {
    let mut proven = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in title.split('\n') {
        if line.trim() == INJECTED_LINE {
            continue;
        }
        if let Some(pt) = language_line_proves_pt(line.trim()) {
            proven |= pt;
            continue;
        }
        kept.push(line);
    }
    let base = kept.join("\n");
    if proven || explicit_pt_audio(&base) || looks_pt_br(&base) {
        return None;
    }
    // A linha crua sai do título gravado também: quem lê o acervo e classifica
    // pelo título (o `Dubbed` genérico conta como PT) não pode repromover.
    Some(base)
}

impl MagnetBankStore {
    /// Roda o reparo uma vez; devolve quantas linhas perderam o `dubbed`.
    pub fn repair_false_dub_once(&self) -> Result<u64, String> {
        let mut conn = self.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS magnet_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .map_err(|err| format!("tabela magnet_meta: {err}"))?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM magnet_meta WHERE key = ?1",
                [MARK],
                |r| r.get(0),
            )
            .optional()
            .map_err(|err| format!("ler marcador: {err}"))?;
        if done.is_some() {
            return Ok(0);
        }
        let tx = conn
            .transaction()
            .map_err(|err| format!("abrir reparo: {err}"))?;
        let rows: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare("SELECT hash, title FROM magnet WHERE is_br = 0 AND dubbed = 1")
                .map_err(|err| format!("ler candidatos: {err}"))?;
            let mapped = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(|err| format!("ler candidatos: {err}"))?;
            mapped
                .collect::<rusqlite::Result<_>>()
                .map_err(|err| format!("ler candidatos: {err}"))?
        };
        let mut fixed: u64 = 0;
        for (hash, title) in rows {
            let Some(base) = false_dub_title(&title) else {
                continue;
            };
            tx.execute(
                "UPDATE magnet SET dubbed = 0, title = ?1 WHERE hash = ?2",
                params![base, hash],
            )
            .map_err(|err| format!("gravar reparo: {err}"))?;
            fixed += 1;
        }
        tx.execute(
            "INSERT OR REPLACE INTO magnet_meta (key, value) VALUES (?1, ?2)",
            params![MARK, fixed.to_string()],
        )
        .map_err(|err| format!("gravar marcador: {err}"))?;
        tx.commit().map_err(|err| format!("fechar reparo: {err}"))?;
        Ok(fixed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regua_do_titulo() {
        // Cena com a linha injetada: perde o dubbed e a linha.
        assert_eq!(
            false_dub_title("Batman Knightfall 2026 2160p MA WEB-DL H265-SCOPE\nPT-BR").as_deref(),
            Some("Batman Knightfall 2026 2160p MA WEB-DL H265-SCOPE")
        );
        assert_eq!(
            false_dub_title("Heart.of.the.Beast.2026.1080p.AMZN.WEB-DL.H.264-KyoGo").as_deref(),
            Some("Heart.of.the.Beast.2026.1080p.AMZN.WEB-DL.H.264-KyoGo")
        );
        // DUAL com sinal de português (BluDV) e PT explícito ficam; anime
        // "Dual Audio" (JA+EN) sai.
        assert_eq!(
            false_dub_title("Coração.Selvagem.2026.WEB-DL.1080p.x264.DUAL.5.1-STARCKFILMES\nPT-BR"),
            None
        );
        assert_eq!(
            false_dub_title(
                "[Sokudo] JUJUTSU KAISEN S03E02 [1080p AV1][Dual Audio] (weekly)\nPT-BR"
            )
            .as_deref(),
            Some("[Sokudo] JUJUTSU KAISEN S03E02 [1080p AV1][Dual Audio] (weekly)")
        );
        assert_eq!(false_dub_title("Filme 2026 1080p DUBLADO"), None);
        assert_eq!(false_dub_title("Filme.2026.1080p.WEB-DL.PT-BR.x264"), None);
        // Linha de idiomas crua de parser antigo: anime JA/EN com legenda PT sai;
        // BluDV com rótulo de áudio + 🇵🇹 fica.
        assert_eq!(
            false_dub_title(
                "[Sokudo] JUJUTSU KAISEN S03E07 [1080p AV1]\nDubbed / Multi Subs / 🇬🇧 / 🇵🇹"
            )
            .as_deref(),
            Some("[Sokudo] JUJUTSU KAISEN S03E07 [1080p AV1]")
        );
        assert_eq!(
            false_dub_title("Filme 2026 1080p WEB-DL\nDubbed / Dual Audio / 🇵🇹"),
            None
        );
    }

    #[test]
    fn reparo_roda_uma_vez_e_poupa_br_e_dublado() {
        let store = MagnetBankStore::open_memory().unwrap();
        let rows = [
            ("a", "Batman 2026 2160p WEB-DL H265-SCOPE\nPT-BR", 0, 1),
            (
                "b",
                "Batman A Queda do Morcego 2026 1080p DUBLADO\nPT-BR",
                0,
                1,
            ),
            ("c", "Batman 2026 2160p WEB-DL H265-SCOPE", 1, 1),
            ("d", "Batman 2026 720p WEB-DL-PSA", 0, 0),
        ];
        for (hash, title, is_br, dubbed) in rows {
            store
                .lock()
                .execute(
                    "INSERT INTO magnet (hash, title, is_br, dubbed) VALUES (?1, ?2, ?3, ?4)",
                    params![hash, title, is_br, dubbed],
                )
                .unwrap();
        }
        assert_eq!(store.repair_false_dub_once().unwrap(), 1);
        let ler = |hash: &str| -> (String, i64) {
            store
                .lock()
                .query_row(
                    "SELECT title, dubbed FROM magnet WHERE hash = ?1",
                    [hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap()
        };
        assert_eq!(
            ler("a"),
            ("Batman 2026 2160p WEB-DL H265-SCOPE".to_string(), 0)
        );
        assert_eq!(ler("b").1, 1, "dublado de verdade fica");
        assert_eq!(ler("c").1, 1, "linha BR não é tocada");
        assert_eq!(ler("d").1, 0);

        // Marcador gravado: a captura que voltar a marcar não é desfeita.
        store
            .lock()
            .execute("UPDATE magnet SET dubbed = 1 WHERE hash = 'a'", [])
            .unwrap();
        assert_eq!(store.repair_false_dub_once().unwrap(), 0);
        assert_eq!(ler("a").1, 1);
    }
}
