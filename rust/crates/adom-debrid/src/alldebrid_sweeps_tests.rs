//! Fixtures da DECISÃO pura das quatro varreduras: inventário, hold,
//! preexistente, retenção BR, `adrm`, prova de áudio, posse (`adsub`),
//! anti-re-add, piso de ocupação, teto por rodada e contagem por motivo.
//!
//! Nenhum teste aqui toca rede: as funções `plan_*` são puras de propósito.

use std::collections::{HashMap, HashSet};

use super::{
    plan_reconcile, plan_revalidate, plan_sweep_dead, plan_sweep_undubbed, MagnetRow, Reason,
    SweepConfig, SweepFacts, SweepKind, SweepMode,
};

const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;
/// `uploadDate` default das linhas: a etiqueta `adsub` nasce junto.
const UPLOADED: i64 = NOW - 30 * DAY;

fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

fn row(ch: char) -> MagnetRow {
    MagnetRow {
        id: format!("id-{ch}"),
        hash: hash_of(ch),
        name: format!("Release {ch}"),
        status: "Ready".into(),
        ready: true,
        uploaded_at_ms: UPLOADED,
        files: vec![format!("Release.{ch}.1080p.WEB-DL.x264-RARBG.mkv")],
    }
}

/// Linha em estado terminal (`DEAD`).
fn dead_row(ch: char) -> MagnetRow {
    MagnetRow {
        status: "Error: no peer".into(),
        ready: false,
        ..row(ch)
    }
}

/// Fatos vivos: o `Facts` guarda os conjuntos e empresta a view.
#[derive(Default)]
struct Facts {
    known_before: Option<HashSet<String>>,
    held: HashSet<String>,
    retained: HashSet<String>,
    owned_at: HashMap<String, i64>,
    marked: HashSet<String>,
    consulted: HashSet<String>,
    suppressed: HashSet<String>,
}

impl Facts {
    /// Inventário carregado (vazio = conta sem preexistentes).
    fn loaded() -> Self {
        Self {
            known_before: Some(HashSet::new()),
            ..Self::default()
        }
    }

    fn keep(mut self, set: fn(&mut Self) -> &mut HashSet<String>, ch: char) -> Self {
        set(&mut self).insert(hash_of(ch));
        self
    }

    fn view(&self) -> SweepFacts<'_> {
        SweepFacts {
            known_before: self.known_before.as_ref(),
            held: &self.held,
            retained: &self.retained,
            owned_at: &self.owned_at,
            marked: &self.marked,
            consulted: &self.consulted,
            suppressed: &self.suppressed,
            now_ms: NOW,
        }
    }
}

fn held(facts: Facts) -> Facts {
    facts.keep(|state| &mut state.held, 'a')
}

fn marked(facts: Facts) -> Facts {
    facts.keep(|state| &mut state.marked, 'a')
}

fn preexisting(facts: Facts) -> Facts {
    facts.keep(|state| state.known_before.as_mut().unwrap(), 'a')
}

fn owned(facts: Facts, ch: char, at_ms: i64) -> Facts {
    let mut facts = facts;
    facts.owned_at.insert(hash_of(ch), at_ms);
    facts
}

#[test]
fn inventario_ausente_zera_delete_nas_quatro() {
    let rows = [dead_row('a'), row('b'), row('c')];
    let facts = Facts::default(); // known_before = None
    let view = facts.view();
    let plans = [
        plan_sweep_dead(&rows, &view, &SweepConfig::dead()),
        plan_sweep_undubbed(&rows, &view, &SweepConfig::undubbed()),
        plan_reconcile(&rows, &view, &SweepConfig::reconcile()),
        plan_revalidate(&rows, &view, &SweepConfig::revalidate()),
    ];
    for plan in &plans {
        assert!(plan.delete.is_empty(), "sem inventário ninguém sai");
        assert_eq!(plan.keep.len(), rows.len());
        assert!(
            plan.skip
                .values()
                .all(|item| *item == Reason::InventoryMissing),
            "o motivo é sempre inventory_missing"
        );
    }
}

#[test]
fn hold_do_autofetch_preserva() {
    let rows = [dead_row('a')];
    let facts = held(Facts::loaded());
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert!(plan.delete.is_empty());
    assert_eq!(plan.skip[&hash_of('a')], Reason::Held);
}

#[test]
fn preexistente_preserva() {
    let rows = [dead_row('a')];
    let facts = preexisting(Facts::loaded());
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert!(plan.delete.is_empty(), "acervo do usuário nunca sai");
    assert_eq!(plan.skip[&hash_of('a')], Reason::Preexisting);
}

#[test]
fn retencao_br_preserva_pack_multiobra() {
    let rows = [row('a'), row('b'), row('c')];
    let mut facts = Facts::loaded();
    for ch in ['a', 'b', 'c'] {
        facts.retained.insert(hash_of(ch));
    }
    let plan = plan_sweep_undubbed(&rows, &facts.view(), &SweepConfig::undubbed());
    assert!(plan.delete.is_empty(), "pack BR retido não sai por obra");
    assert_eq!(plan.count(Reason::RetentionBr), 3);
}

#[test]
fn adrm_preserva_na_reconciliacao() {
    let rows = [row('a')];
    // Etiqueta de posse no instante do upload (`adsub.at` ≈ `uploadDate`).
    let facts = marked(owned(Facts::loaded(), 'a', UPLOADED));
    let plan = plan_reconcile(&rows, &facts.view(), &SweepConfig::reconcile());
    assert!(
        plan.delete.is_empty(),
        "hash já apagado de propósito não volta"
    );
    assert_eq!(plan.skip[&hash_of('a')], Reason::Marked);
    // Sem a marca, o MESMO magnet sai — a marca é o único freio.
    let clean = owned(Facts::loaded(), 'a', UPLOADED);
    let plan = plan_reconcile(&rows, &clean.view(), &SweepConfig::reconcile());
    assert_eq!(plan.delete, vec![hash_of('a')]);
}

#[test]
fn sweep_dead_pronto_e_acervo_e_morto_sai() {
    let rows = [row('a'), dead_row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert_eq!(plan.delete, vec![hash_of('b')]);
    assert_eq!(plan.skip[&hash_of('a')], Reason::Ready);
}

#[test]
fn sweep_dead_recente_fica_e_sem_data_sai() {
    let mut recent = dead_row('a');
    recent.uploaded_at_ms = NOW - 60_000;
    let mut unknown = dead_row('b');
    unknown.uploaded_at_ms = 0;
    let rows = [recent, unknown];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert_eq!(plan.skip[&hash_of('a')], Reason::TooYoung);
    assert_eq!(plan.delete, vec![hash_of('b')]);
}

#[test]
fn sweep_undubbed_exige_prova_de_audio() {
    // Título condenaria (grupo EN), mas sem caminho de vídeo não há prova.
    let mut no_files = row('a');
    no_files.name = "Release 1080p WEB-DL x264-RARBG".into();
    no_files.files.clear();
    let rows = [no_files];
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&rows, &facts.view(), &SweepConfig::undubbed());
    assert!(plan.delete.is_empty(), "título nunca condena");
    assert_eq!(plan.skip[&hash_of('a')], Reason::NoAudioProof);
}

#[test]
fn sweep_undubbed_prova_de_arquivo_decide() {
    // Marcador PT no ARQUIVO absolve, mesmo com grupo EN no título.
    let mut pt_file = row('a');
    pt_file.name = "Release 1080p WEB-DL x264-RARBG".into();
    pt_file.files = vec!["Release.1080p.Dublado.mkv".into()];
    // Grupo EN no arquivo condena.
    let foreign = row('b');
    // Áudio ambíguo fica para a auditoria de arquivos.
    let mut ambiguous = row('c');
    ambiguous.name = "Release 1080p WEB-DL".into();
    ambiguous.files = vec!["Release.1080p.WEB-DL.mkv".into()];
    let rows = [pt_file, foreign, ambiguous];
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&rows, &facts.view(), &SweepConfig::undubbed());
    assert_eq!(plan.delete, vec![hash_of('b')]);
    assert_eq!(plan.skip[&hash_of('a')], Reason::PtProof);
    assert_eq!(plan.skip[&hash_of('c')], Reason::ForeignUnknown);
}

#[test]
fn reconcile_exige_posse_e_nao_remove_readd() {
    // `c` foi RE-SUBIDO pelo usuário 1 h atrás: upload mais novo que a etiqueta.
    let mut readd = row('c');
    readd.uploaded_at_ms = NOW - 60 * 60 * 1000;
    let rows = [row('a'), row('b'), readd, row('d')];
    let mut facts = Facts::loaded();
    // `a` é nosso, antigo e não foi re-subido: sai.
    facts.owned_at.insert(hash_of('a'), UPLOADED);
    facts.owned_at.insert(hash_of('c'), UPLOADED);
    // `d` é nosso, mas ESTA busca consultou o hash.
    facts.owned_at.insert(hash_of('d'), UPLOADED);
    facts.consulted.insert(hash_of('d'));
    let plan = plan_reconcile(&rows, &facts.view(), &SweepConfig::reconcile());
    assert_eq!(plan.delete, vec![hash_of('a')]);
    assert_eq!(plan.skip[&hash_of('b')], Reason::NoOwnership);
    assert_eq!(plan.skip[&hash_of('c')], Reason::Readded);
    assert_eq!(plan.skip[&hash_of('d')], Reason::ConsultedThisSearch);
}

#[test]
fn reconcile_piso_de_ocupacao_desiste() {
    let rows = [row('a'), row('b')];
    let facts = owned(Facts::loaded(), 'a', UPLOADED);
    let config = SweepConfig {
        floor: 10,
        ..SweepConfig::reconcile()
    };
    let plan = plan_reconcile(&rows, &facts.view(), &config);
    assert!(plan.delete.is_empty(), "conta folgada não é varrida");
    assert_eq!(plan.count(Reason::Floor), 2);
}

#[test]
fn revalidate_cura_ausente_e_apaga_terminal_com_posse() {
    let rows = [dead_row('a'), row('b')];
    let mut facts = owned(Facts::loaded(), 'a', UPLOADED);
    facts.suppressed.insert(hash_of('a'));
    facts.suppressed.insert(hash_of('b'));
    facts.suppressed.insert(hash_of('c')); // sumiu da conta
    let plan = plan_revalidate(&rows, &facts.view(), &SweepConfig::revalidate());
    assert_eq!(plan.delete, vec![hash_of('a')]);
    assert_eq!(plan.skip[&hash_of('b')], Reason::NotDead);
    assert_eq!(plan.skip[&hash_of('c')], Reason::Gone);
}

#[test]
fn teto_por_rodada_pega_os_mais_antigos() {
    let mut old = row('a');
    old.uploaded_at_ms = NOW - 90 * DAY;
    let mut middle = row('b');
    middle.uploaded_at_ms = NOW - 60 * DAY;
    let rows = [row('c'), old, middle];
    let facts = Facts::loaded();
    let config = SweepConfig {
        max_per_round: 1,
        ..SweepConfig::undubbed()
    };
    let plan = plan_sweep_undubbed(&rows, &facts.view(), &config);
    assert_eq!(
        plan.delete,
        vec![hash_of('a')],
        "o mais antigo sai primeiro"
    );
    assert_eq!(plan.count(Reason::CapExceeded), 2);
}

#[test]
fn motivo_contabilizado_por_categoria() {
    let mut no_proof = row('a');
    no_proof.files.clear();
    let mut pt_file = row('b');
    pt_file.files = vec!["Release.Dublado.mkv".into()];
    let mut ambiguous = row('c');
    ambiguous.name = "Release 1080p".into();
    ambiguous.files = vec!["Release.1080p.mkv".into()];
    let rows = [no_proof, pt_file, ambiguous];
    let facts = Facts::loaded();
    let plan = plan_sweep_undubbed(&rows, &facts.view(), &SweepConfig::undubbed());
    let counts = plan.reason_counts();
    assert_eq!(counts[Reason::NoAudioProof.as_str()], 1);
    assert_eq!(counts[Reason::PtProof.as_str()], 1);
    assert_eq!(counts[Reason::ForeignUnknown.as_str()], 1);
}

#[test]
fn linha_sem_hash_nao_apaga() {
    let mut broken = dead_row('a');
    broken.hash = "   ".into();
    let rows = [broken];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::dead());
    assert!(plan.delete.is_empty());
    assert_eq!(plan.skip[&"#id-a".to_string()], Reason::NoHash);
}

#[test]
fn default_nao_apaga_nada() {
    let rows = [dead_row('a'), row('b')];
    let facts = Facts::loaded();
    let plan = plan_sweep_dead(&rows, &facts.view(), &SweepConfig::default());
    assert!(plan.delete.is_empty(), "Default fechado: teto 0");
    assert_eq!(plan.count(Reason::CapExceeded), 1);
}

#[test]
fn modo_vem_das_flags_do_chamador() {
    assert_eq!(SweepMode::from_flags(false, false), SweepMode::Off);
    assert_eq!(SweepMode::from_flags(false, true), SweepMode::Off);
    assert_eq!(SweepMode::from_flags(true, true), SweepMode::ReadOnly);
    assert_eq!(SweepMode::from_flags(true, false), SweepMode::Apply);
    assert_eq!(SweepMode::parse("read_only"), SweepMode::ReadOnly);
    assert_eq!(SweepMode::parse("on"), SweepMode::Apply);
    assert_eq!(SweepMode::parse("qualquer"), SweepMode::Off);
    assert!(SweepMode::ReadOnly.plans() && !SweepMode::ReadOnly.deletes());
    assert!(!SweepMode::Off.plans() && !SweepMode::Off.deletes());
    assert!(SweepMode::Apply.plans() && SweepMode::Apply.deletes());
}

#[test]
fn kind_parse_aceita_o_vocabulario_do_painel() {
    // A rota manual aceita o nome canônico e as grafias com `_`/`-`.
    for (raw, expected) in [
        ("sweepDead", SweepKind::Dead),
        ("sweep_dead", SweepKind::Dead),
        ("sweep-undubbed", SweepKind::Undubbed),
        ("SWEEPUNDUBBED", SweepKind::Undubbed),
        ("Reconcile", SweepKind::Reconcile),
        ("  revalidate ", SweepKind::Revalidate),
    ] {
        assert_eq!(SweepKind::parse(raw), Some(expected), "{raw}");
        assert_eq!(SweepKind::parse(expected.as_str()), Some(expected));
    }
    // Desconhecido/vazio é `None`: nunca um default que apagaria outro tipo.
    assert_eq!(SweepKind::parse(""), None);
    assert_eq!(SweepKind::parse("all"), None);
    assert_eq!(SweepKind::parse("dead"), None, "nome curto não é canônico");
}
