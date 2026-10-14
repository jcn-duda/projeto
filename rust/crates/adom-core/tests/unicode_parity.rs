//! Regressões de paridade Unicode de `normalizeTitle` (fatia F1).
//!
//! Cada `expected` abaixo é a saída REAL do oráculo Node (dist vivo, v22.23.2,
//! unicode=17.0 / ICU 78.2), executada na bancada do diagnóstico — nunca
//! `input == expected` por conveniência. Cobrem os contraexemplos que quebravam
//! a paridade quando o Rust usava tabelas Unicode 16.0 (regex publicado e
//! `std` < 1.92): letras novas (U+1E6C0 Tai Yo, U+10940 Sidetic, U+2EBF0 CJK),
//! pares de caixa novos (U+A7CE→A7CF, U+A7D2→A7D3, U+A7D4→A7D5), siglas
//! pontuadas com letra nova e a distinção Alphabetic×Letter (U+24B6/U+1F130),
//! que só General_Category resolve.
//!
//! NÃO é claim universal: a paridade exaustiva de `\p{L}/\p{N}/\p{M}` e do
//! `toLowerCase` sobre todos os code points foi medida em bancada separada.
//! Aqui ficam os 45 vetores permanentes, somados aos 23 goldens de
//! `golden_corpus.rs` (68 no total) e aos 8 vetores do quirk UTF-16 do glue da
//! sigla (`GLUE_PROBES`, 76 no total).

use adom_core::normalize_title;

/// (id, entrada, esperado Node real).
const PROBES: &[(&str, &str, &str)] = &[
    ("p01", "\u{1E6C0}", "\u{1E6C0}"),
    ("p02", "\u{10940}", "\u{10940}"),
    ("p03", "\u{2EBF0}", "\u{2EBF0}"),
    ("p04", "\u{1C89}\u{1C8A}", "\u{1C8A}\u{1C8A}"),
    ("p05", "\u{A7CE}", "\u{A7CF}"),
    ("p06", "\u{A7D2}", "\u{A7D3}"),
    ("p07", "\u{A7D4}", "\u{A7D5}"),
    ("p08", "\u{A7CF}", "\u{A7CF}"),
    ("p09", "\u{A7D3}", "\u{A7D3}"),
    ("p10", "\u{A7D5}", "\u{A7D5}"),
    ("p11", "\u{0130}stanbul", "istanbul"),
    (
        "p12",
        "\u{01C4}\u{01C5}\u{01C6}",
        "\u{01C6}\u{01C6}\u{01C6}",
    ),
    ("p13", "\u{01C5}", "\u{01C6}"),
    ("p14", "X.\u{1E6C0}.Z.", "x\u{1E6C0}z"),
    ("p15", "X.\u{10940}.Z.", "x\u{10940}z"),
    ("p16", "X.\u{2EBF0}.Z.", "x\u{2EBF0}z"),
    ("p17", "X.\u{1C8A}.Z.", "x\u{1C8A}z"),
    ("p18", "X.\u{A7CE}.Z.", "x\u{A7CF}z"),
    ("p19", "X.\u{A7CF}.Z.", "x\u{A7CF}z"),
    ("p20", "X.\u{24B6}.Z.", "x z"),
    ("p21", "X.\u{1F130}.Z.", "x z"),
    ("p22", "X.\u{0301}.Z.", "x z"),
    ("p23", "e\u{0301}", "e"),
    ("p24", "e\u{20D0}", "e\u{20D0}"),
    ("p25", "e\u{FE20}", "e\u{FE20}"),
    ("p26", "e\u{3099}", "e\u{3099}"),
    ("p27", "\u{03B1}\u{0301}", "\u{03B1}"),
    ("p28", "\u{0903}", "\u{0903}"),
    ("p29", "\u{0902}", "\u{0902}"),
    (
        "p30",
        "\u{FF11}\u{FF12}\u{FF13}",
        "\u{FF11}\u{FF12}\u{FF13}",
    ),
    ("p31", "\u{0663} \u{0664}", "\u{0663} \u{0664}"),
    ("p32", "\u{00BD} \u{00BC} \u{00BE}", ""),
    ("p33", "\u{00B9}\u{00B2}\u{00B3}", ""),
    ("p34", "\u{1C89}\u{1E6C0}", "\u{1C8A}\u{1E6C0}"),
    (
        "p35",
        "\u{039F}\u{0394}\u{039F}\u{03A3}",
        "\u{03BF}\u{03B4}\u{03BF}\u{03C2}",
    ),
    (
        "p36",
        "\u{03A3}\u{03A3} \u{03C3}",
        "\u{03C3}\u{03C2} \u{03C3}",
    ),
    (
        "p37",
        "\u{039C}\u{0386}\u{0399}\u{039F}\u{03A3}",
        "\u{03BC}\u{03B1}\u{03B9}\u{03BF}\u{03C2}",
    ),
    ("p38", "\u{1FAE8}", ""),
    ("p39", "a\u{1FAE8}b", "a b"),
    ("p40", "\u{24B6}", ""),
    ("p41", "a\u{24B6}b", "a b"),
    ("p42", "a\u{1F130}b", "a b"),
    ("p43", "G.O.R.A.", "gora"),
    ("p44", "Se7en   Dual\t\u{00C1}udio", "se7en dual audio"),
    (
        "p45",
        "\u{1E6C0}.\u{10940}.\u{2EBF0}.",
        "\u{1E6C0}\u{10940}\u{2EBF0}",
    ),
];

#[test]
fn normalize_title_bate_com_os_45_vetores_unicode17() {
    assert_eq!(
        PROBES.len(),
        45,
        "a fatia cobre 45 vetores, sem duplicar golden"
    );
    for &(id, input, expected) in PROBES {
        let obtido = normalize_title(input);
        assert_eq!(
            obtido, expected,
            "vetor {id} divergiu do oráculo Node\nentrada:  {input:?}\nesperado: {expected:?}\nobtido:   {obtido:?}"
        );
    }
}

/// Os contraexemplos de letra/caixa nova PRECISAM entregar o valor do Node 17 —
/// o que o Rust produzia com tabelas Unicode 16 (letra nova virando separador,
/// caixa nova intacta) é explicitamente rejeitado, não só "diferente do input".
#[test]
fn contraexemplos_nao_regridem_para_a_saida_unicode16() {
    // regex 16.0: 'X.<letra nova>.Z.' -> 'x z' (a letra sumia).
    assert_eq!(normalize_title("X.\u{1E6C0}.Z."), "x\u{1E6C0}z");
    assert_eq!(normalize_title("X.\u{10940}.Z."), "x\u{10940}z");
    // std 16.0: a caixa nova não baixava (U+A7CE saía intacto).
    assert_eq!(normalize_title("\u{A7CE}"), "\u{A7CF}");
    assert_eq!(normalize_title("\u{A7D2}"), "\u{A7D3}");
    assert_eq!(normalize_title("\u{A7D4}"), "\u{A7D5}");
    // Alphabetic != Letter: U+24B6 é Alphabetic mas não é \p{L}.
    assert_eq!(normalize_title("\u{24B6}"), "");
}

/// Glue da sigla pontuada (`collapseAcronyms`): o TS lê
/// `all.charAt(at + m.length)` — UMA unidade UTF-16, não um code point — e testa
/// essa unidade contra `[\p{L}\p{N}]`. Logo, um escalar astral
/// (`len_utf16()==2`) logo após a sigla é visto pela METADE (surrogate alto,
/// General_Category=Cs) e NUNCA ganha espaço; só uma unidade BMP
/// (`len_utf16()==1`) que seja letra/número glua. Isto NÃO é regra do Unicode
/// 17: vale para qualquer astral, inclusive pré-17 (ex.: U+1D538). A cauda
/// opcional e as lookarounds do regex usam code point inteiro e NÃO seguem esta
/// regra — o porte não pode "consertar" a assimetria para uma regra só.
///
/// Cada `expected` é a saída REAL do oráculo Node (dist vivo, v22.23.2,
/// unicode=17.0 / ICU 78.2, sem `.env`), nunca `input == expected`.
const GLUE_PROBES: &[(&str, &str, &str)] = &[
    ("g01", "A.B.\u{1E6C0}Y", "ab\u{1E6C0}y"), // astral letra + letra BMP
    ("g02", "A.B.\u{1E6C0}", "ab\u{1E6C0}"),   // astral absorvida como cauda
    ("g03", "A.B.\u{1E6C0}!", "ab\u{1E6C0}"),  // cauda astral + '!'
    ("g04", "A.B.X\u{1E6C0}", "ab x\u{1E6C0}"), // X BMP (não é cauda) glua
    ("g05", "A.B.\u{00E9}Y", "ab ey"),         // é BMP glua
    ("g06", "A.B.XY", "ab xy"),                // BMP glua (controle)
    ("g07", "A.B.\u{1D7CE}Y", "ab\u{1D7CE}y"), // astral NÚMERO: mesma regra
    ("g08", "A.B.\u{1D538}Y", "ab\u{1D538}y"), // astral letra PRÉ-Unicode 17
];

#[test]
fn glue_da_sigla_espelha_o_charat_utf16_do_js() {
    assert_eq!(GLUE_PROBES.len(), 8, "8 vetores do glue da sigla");
    for &(id, input, expected) in GLUE_PROBES {
        let obtido = normalize_title(input);
        assert_eq!(
            obtido, expected,
            "glue {id} divergiu do oráculo Node\nentrada:  {input:?}\nesperado: {expected:?}\nobtido:   {obtido:?}"
        );
    }
}
