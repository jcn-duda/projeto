//! Porte puro de `src/utils/release-index-cut.ts`: o corte do teto por obra do
//! índice de releases (`cutProtected`).
//!
//! Proteção BR/dublado: nunca caem pelo relógio — o colhedor é o único caminho
//! de volta para um global expulso —, mas não podem ocupar TODAS as vagas. O
//! excedente protegido ainda preenche o que sobrar (obra que só tem BR não
//! encolhe); o que não couber é contado (`search.idx.protCap` no Node).
//!
//! Ordenação idêntica ao `.sort` do TS, que é ESTÁVEL: `isBr||dubbed` desc,
//! `seenAt` desc, `seeders` desc, empate na ordem de inserção.

/// Chaves de ordenação/proteção de UMA release. O chamador (store do índice)
/// converte a linha persistida; o núcleo não conhece `idx:v14`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CutKey {
    pub is_br: bool,
    pub dubbed: bool,
    pub seen_at: i64,
    pub seeders: i64,
}

impl CutKey {
    fn protected(&self) -> bool {
        self.is_br || self.dubbed
    }
}

/// Aplica o corte de `max` releases. Devolve as mantidas NA ORDEM do corte e
/// quantas protegidas ficaram de fora (métrica `search.idx.protCap`).
///
/// `max` é normalizado pelo chamador (`>= 1`), como no TS.
pub fn cut_protected<T: Clone>(
    items: &[T],
    max: usize,
    key: impl Fn(&T) -> CutKey,
) -> (Vec<T>, usize) {
    let max = max.max(1);
    let protected_cap = (max * 2 / 3).max(1);
    let mut ordered: Vec<(usize, T)> = items.iter().cloned().enumerate().collect();
    // `sort_by` do Rust é estável: empate preserva a ordem recebida, como o
    // Array.prototype.sort do V8.
    ordered.sort_by(|(_, a), (_, b)| {
        let ka = key(a);
        let kb = key(b);
        kb.protected()
            .cmp(&ka.protected())
            .then_with(|| kb.seen_at.cmp(&ka.seen_at))
            .then_with(|| kb.seeders.cmp(&ka.seeders))
    });
    let mut kept: Vec<T> = Vec::with_capacity(max.min(ordered.len()));
    let mut blocked: Vec<T> = Vec::new();
    let mut protected_kept = 0usize;
    for (_, item) in ordered {
        if kept.len() >= max {
            break;
        }
        if !key(&item).protected() {
            kept.push(item);
            continue;
        }
        if protected_kept < protected_cap {
            protected_kept += 1;
            kept.push(item);
        } else {
            blocked.push(item);
        }
    }
    let mut dropped = 0usize;
    for item in blocked {
        if kept.len() < max {
            kept.push(item);
        } else {
            dropped += 1;
        }
    }
    (kept, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(is_br: bool, dubbed: bool, seen_at: i64, seeders: i64, id: &str) -> serde_json::Value {
        json!({"isBr": is_br, "dubbed": dubbed, "seenAt": seen_at, "seeders": seeders, "hash": id})
    }

    fn key(value: &serde_json::Value) -> CutKey {
        CutKey {
            is_br: value["isBr"].as_bool().unwrap_or(false),
            dubbed: value["dubbed"].as_bool().unwrap_or(false),
            seen_at: value["seenAt"].as_i64().unwrap_or(0),
            seeders: value["seeders"].as_i64().unwrap_or(0),
        }
    }

    fn hashes(list: &[serde_json::Value]) -> Vec<String> {
        list.iter()
            .map(|v| v["hash"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn protege_br_mas_nao_todas_as_vagas() {
        let mut list = Vec::new();
        for i in 0..6 {
            list.push(item(true, false, 100 + i, 1, &format!("br{i}")));
        }
        for i in 0..6 {
            list.push(item(false, false, 200 + i, 50, &format!("en{i}")));
        }
        let (kept, dropped) = cut_protected(&list, 6, key);
        assert_eq!(kept.len(), 6);
        assert_eq!(dropped, 2, "4 BR (2/3 de 6) + 2 globais mais novos");
        let out = hashes(&kept);
        // Os 4 BR mais novos primeiro (protegidos), depois os 2 globais.
        assert_eq!(out[0..4], ["br5", "br4", "br3", "br2"]);
        assert!(out[4].starts_with("en"));
    }

    #[test]
    fn obra_so_br_preenche_vagas_ociosas() {
        let list: Vec<_> = (0..5)
            .map(|i| item(true, false, 100 + i, 1, &format!("br{i}")))
            .collect();
        let (kept, dropped) = cut_protected(&list, 4, key);
        assert_eq!(kept.len(), 4);
        assert_eq!(
            dropped, 1,
            "o excedente protegido ocupa as vagas que sobraram; o resto vira protCap"
        );
        assert_eq!(hashes(&kept), ["br4", "br3", "br2", "br1"]);
    }

    #[test]
    fn desempate_e_estavel() {
        let list = vec![
            item(false, false, 100, 10, "a"),
            item(false, false, 100, 10, "b"),
            item(false, false, 100, 10, "c"),
        ];
        let (kept, _) = cut_protected(&list, 2, key);
        assert_eq!(hashes(&kept), ["a", "b"], "ordem de inserção no empate");
    }

    #[test]
    fn dubbed_protege_como_br() {
        let list = vec![
            item(false, true, 10, 1, "dub"),
            item(false, false, 99, 99, "en"),
        ];
        let (kept, _) = cut_protected(&list, 2, key);
        assert_eq!(hashes(&kept), ["dub", "en"]);
    }
}
