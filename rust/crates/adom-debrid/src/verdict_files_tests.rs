//! Testes sem rede da conversão e do filtro da leitura de arquivos.

use super::*;

fn sweep(path: &str, size: f64) -> SweepFile {
    SweepFile {
        path: path.to_string(),
        size,
    }
}

#[test]
fn converte_e_descarta_tamanho_invalido_e_caminho_vazio() {
    let files = vec![
        sweep("Pasta/Filme.mkv", 4_000.0),
        sweep("zero.mkv", 0.0),
        sweep("negativo.mkv", -1.0),
        sweep("nan.mkv", f64::NAN),
        sweep("", 900.0),
        sweep("Outro.mp4", 1.0),
    ];
    let out = sweep_files_to_debrid(files);
    let pares: Vec<(&str, f64)> = out.iter().map(|f| (f.path.as_str(), f.size)).collect();
    assert_eq!(
        pares,
        vec![("Pasta/Filme.mkv", 4_000.0), ("Outro.mp4", 1.0)]
    );
}

#[test]
fn lista_vazia_continua_vazia() {
    assert!(sweep_files_to_debrid(Vec::new()).is_empty());
}

#[test]
fn pedidos_viram_minusculas_sem_vazios() {
    let pedidos = vec![
        " ABCdef ".to_string(),
        "abcdef".to_string(),
        "   ".to_string(),
        String::new(),
    ];
    let set = wanted_hashes(&pedidos);
    assert_eq!(set.len(), 1);
    assert!(set.contains("abcdef"));
}
