//! Prova de audio (`provenAudio`/`provenName`) vinda do `apply-debrid.json`.

use std::collections::BTreeMap;

use serde_json::Value;

use super::annotate::applied_hash;
use super::capture::{ApplyDebridFile, FileEntry};

/// Veredito de áudio PROVADO — o que o `applyFileEvidence` do Node anexa ao
/// item antes do build (`provenAudio`/`provenName`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct AudioProof {
    /// Rótulo de áudio (`Dublado`/`Dual`/`Nacional`/`Legendado`).
    pub(super) audio: String,
    /// Nome do arquivo maior (vazio em coleção multiobra).
    pub(super) name: String,
}

/// Rótulo do chip de áudio que o Node renderizou (`compact_audio`):
/// `DUB`→Dublado, `DUAL`→Dual, `NAC`→Nacional, `LEG`→Legendado.
pub(super) fn chip_audio_label(name: &str) -> Option<&'static str> {
    name.split_whitespace().find_map(|token| match token {
        "DUB" => Some("Dublado"),
        "DUAL" => Some("Dual"),
        "NAC" => Some("Nacional"),
        "LEG" => Some("Legendado"),
        _ => None,
    })
}

/// Vídeos de conteúdo da lista (`contentPaths` do `audio-audit.ts`): o que é
/// vídeo, tem tamanho e não é sample nem propaganda.
pub(super) fn content_files(list: Option<&Vec<FileEntry>>) -> Vec<&FileEntry> {
    list.map(|list| {
        list.iter()
            .filter(|file| {
                file.size > 0.0
                    && adom_core::is_video(&file.path)
                    && !adom_core::is_sample(&file.path)
                    && !adom_core::is_site_ad(&file.path)
            })
            .collect()
    })
    .unwrap_or_default()
}

/// Rótulo de áudio que o Node tiraria desta lista (`recordFileEvidence`):
/// primeiro arquivo com rótulo, na ordem da lista.
pub(super) fn file_audio_label(list: Option<&Vec<FileEntry>>) -> Option<String> {
    let videos = content_files(list);
    videos
        .iter()
        .map(|file| adom_core::audio_from_title(&adom_core::base_name(&file.path)))
        .find(|label| !label.is_empty())
        .map(str::to_string)
}

/// `n` do `FileEvidence`: `baseName(maior.path).slice(0, 80)`, vazio em coleção
/// multiobra (o maior arquivo é outro filme).
pub(super) fn file_evidence_name(list: Option<&Vec<FileEntry>>) -> String {
    let videos = content_files(list);
    let Some(&maior) = videos
        .iter()
        .reduce(|best, file| if file.size > best.size { file } else { best })
    else {
        return String::new();
    };
    let debrid: Vec<adom_core::DebridFile> = videos
        .iter()
        .map(|file| adom_core::DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect();
    if adom_core::looks_multi_work_files(&debrid) {
        return String::new();
    }
    // `slice(0, 80)` do JS; nome de arquivo é UTF-8 válido aqui, então cortar
    // por `char` é equivalente e nunca parte um caractere.
    adom_core::base_name(&maior.path).chars().take(80).collect()
}

/// Reconstrói `provenAudio`/`provenName` a partir do `apply-debrid.json`.
///
/// O caso NÃO grava a prova de áudio: `index.json`/`collect.json` são
/// fotografados ANTES do `applyFileEvidence` e o record só repõe
/// `provenQuality`. O `apply-debrid.json`, porém, é gravado DEPOIS do build e
/// carrega o veredito já aplicado (`_dubbed` + o chip no `name`) — a mesma
/// fonte que [`applied_qualities`] já usa para `_quality`.
///
/// Só entra item com prova POSITIVA (`_dubbed: true`): sem ela não há como
/// distinguir "sem prova" de "prova negativa" (release EN), e inventar a
/// segunda derrubaria o `_dubClaim` do título. O rótulo vem do chip do nome
/// (`DUB`/`DUAL`/`NAC`/`LEG`); sem chip — o `Dual` sem prova PT não renderiza
/// chip — vem da lista `fsz`, o mesmo arquivo de onde o Node tirou a evidência.
///
/// **Contrato que falta no record** (lado Node, fora deste escopo): gravar
/// `inputs/file-evidence.json` = `{ "<hash>": { "a": "...", "n": "..." } }` do
/// `releaseIndex.fileEvidence`, como já se faz com `proven-quality.json` — aí
/// esta reconstrução deixa de ser necessária.
pub(super) fn applied_audio_proofs(
    applied: &[ApplyDebridFile],
    files: &BTreeMap<String, Vec<FileEntry>>,
) -> BTreeMap<String, AudioProof> {
    let mut out: BTreeMap<String, AudioProof> = BTreeMap::new();
    // Só a PRIMEIRA chamada (a passada da resposta). O `apply-debrid.json`
    // também guarda a passada tardia, e ela pode ter `_dubbed:true`/chip DUAL
    // que o corpo do cliente NÃO tinha (medido em Harry Potter 1: a tardia
    // rotulava DUAL um item que a primeira exibia sem chip). O `expected` é a
    // primeira build; as provas têm que vir dela.
    let Some(file) = applied.first() else {
        return out;
    };
    for item in &file.output {
        let Some(hash) = applied_hash(item) else {
            continue;
        };
        if item.get("_dubbed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let list = files.get(&hash);
        let label = item
            .get("name")
            .and_then(Value::as_str)
            .and_then(chip_audio_label)
            .map(str::to_string)
            .or_else(|| file_audio_label(list))
            .unwrap_or_else(|| "Dual".to_string());
        out.insert(
            hash,
            AudioProof {
                audio: label,
                name: file_evidence_name(list),
            },
        );
    }
    out
}
