//! Regressões OFFLINE da mescla de `FileSizesSource` no contexto do build.
//! Nada de rede: a fonte é um fake que registra os hashes pedidos.

use std::sync::Mutex;

use adom_core::DebridFile;

use super::*;

const HASH_A: &str = "AAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_A_LOWER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn item(hash: &str) -> RawItem {
    RawItem {
        info_hash: Some(hash.into()),
        ..RawItem::default()
    }
}

fn file(path: &str, size: f64) -> DebridFile {
    DebridFile {
        path: path.into(),
        size,
    }
}

/// Fonte fake: devolve o que tem para os hashes pedidos e guarda cada pedido.
#[derive(Default)]
struct RecordingSource {
    files: BTreeMap<String, Vec<DebridFile>>,
    totals: BTreeMap<String, f64>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl FileSizesSource for RecordingSource {
    fn files_for(&self, hashes: &[String]) -> BTreeMap<String, Vec<DebridFile>> {
        self.calls.lock().unwrap().push(hashes.to_vec());
        self.files
            .iter()
            .filter(|(hash, _)| hashes.contains(hash))
            .map(|(hash, files)| (hash.clone(), files.clone()))
            .collect()
    }

    fn totals_for(&self, hashes: &[String]) -> BTreeMap<String, f64> {
        self.calls.lock().unwrap().push(hashes.to_vec());
        self.totals
            .iter()
            .filter(|(hash, _)| hashes.contains(hash))
            .map(|(hash, total)| (hash.clone(), *total))
            .collect()
    }
}

#[test]
fn pede_hashes_unicos_e_minusculos() {
    // Mesmo hash em maiúsculas e minúsculas, mais um vazio: a fonte recebe
    // cada hash uma vez, em minúsculas, e o vazio não é pedido.
    let items = vec![item(HASH_A), item(HASH_A_LOWER), item(HASH_B), item("")];
    let source = RecordingSource::default();
    let mut ctx = BuildContext::default();
    merge_file_sizes(Some(&source), &items, &mut ctx);

    let calls = source.calls.lock().unwrap();
    assert!(!calls.is_empty());
    for pedido in calls.iter() {
        assert_eq!(pedido, &vec![HASH_A_LOWER.to_string(), HASH_B.to_string()]);
    }
}

#[test]
fn mapa_do_replay_vence_o_da_fonte() {
    let source = RecordingSource {
        files: BTreeMap::from([(
            HASH_A_LOWER.to_string(),
            vec![file("da-fonte.mkv", 1.0)],
        )]),
        totals: BTreeMap::from([(HASH_A_LOWER.to_string(), 1.0)]),
        ..RecordingSource::default()
    };
    let mut ctx = BuildContext::default();
    ctx.files_by_hash.insert(
        HASH_A_LOWER.to_string(),
        vec![file("do-replay.mkv", 2.0)],
    );
    ctx.totals_by_hash.insert(HASH_A_LOWER.to_string(), 2.0);

    merge_file_sizes(Some(&source), &[item(HASH_A)], &mut ctx);

    assert_eq!(
        ctx.files_by_hash[HASH_A_LOWER],
        vec![file("do-replay.mkv", 2.0)]
    );
    assert_eq!(ctx.totals_by_hash[HASH_A_LOWER], 2.0);
}

#[test]
fn hash_novo_entra_do_source() {
    let source = RecordingSource {
        files: BTreeMap::from([(HASH_B.to_string(), vec![file("pack/ep1.mkv", 3.0)])]),
        totals: BTreeMap::from([(HASH_B.to_string(), 9.0)]),
        ..RecordingSource::default()
    };
    let mut ctx = BuildContext::default();
    merge_file_sizes(Some(&source), &[item(HASH_B)], &mut ctx);

    assert_eq!(ctx.files_by_hash[HASH_B], vec![file("pack/ep1.mkv", 3.0)]);
    assert_eq!(ctx.totals_by_hash[HASH_B], 9.0);
}

#[test]
fn sem_fonte_nada_muda() {
    let mut ctx = BuildContext::default();
    ctx.totals_by_hash.insert(HASH_B.to_string(), 5.0);
    merge_file_sizes(None, &[item(HASH_A)], &mut ctx);

    assert!(ctx.files_by_hash.is_empty());
    assert_eq!(ctx.totals_by_hash.len(), 1);
    assert_eq!(ctx.totals_by_hash[HASH_B], 5.0);
}

#[test]
fn sem_hashes_a_fonte_nao_e_chamada() {
    let source = RecordingSource::default();
    let mut ctx = BuildContext::default();
    // Lista vazia e itens sem hash (só magnet vazio) são o mesmo caso.
    merge_file_sizes(Some(&source), &[], &mut ctx);
    merge_file_sizes(Some(&source), &[RawItem::default()], &mut ctx);

    assert!(source.calls.lock().unwrap().is_empty());
}
