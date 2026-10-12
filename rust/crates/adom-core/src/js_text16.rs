//! Texto no modelo UTF-16 do `String` do JS.
//!
//! O `String` do Rust é uma sequência de `char` (sempre escalares Unicode
//! válidos) e por isso NÃO consegue representar o surrogate órfão que o
//! `slice` em unidades UTF-16 do JS produz ao cortar um par astral ao meio. O
//! `compactTracker` fatia exatamente assim (`label.slice(0, 14)`), e o quirk é
//! contrato: o oráculo Node congela o resultado em `expectedJson` com o órfão
//! escapado (`\uD83D`). `JsText` guarda as unidades UTF-16 cruas e o
//! `js_stringify` reproduz o escape do `JSON.stringify`.
//!
//! Não existe conversão lossy pública de propósito: quem precisa de `&str`
//! (comparação/consulta) só tem caminho quando o texto é bem formado
//! (`is_well_formed`); o resto passa por `js_stringify`, que mantém o órfão.

/// Sequência de unidades UTF-16, como o `String` do JS. Pode conter surrogate
/// órfão, que o `String` do Rust não consegue representar.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JsText(Vec<u16>);

impl JsText {
    /// `String(s)` do JS para um `s` já válido em UTF-8.
    // `String(s)` do JS não é `FromStr` (não falha e nunca é genérico): o nome
    // `from_str` é o do contrato do porte, não uma implementação do trait.
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        Self(s.encode_utf16().collect())
    }

    /// Constrói a partir de unidades cruas (usada pela fatia e pelo decodificador
    /// de literal JSON). Não valida pares: o órfão é preservado de propósito.
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }

    /// Unidades UTF-16 cruas, na ordem. Necessário para materializar um
    /// `string` do Node com órfão (bindings) sem passar por conversão lossy.
    pub fn as_units(&self) -> &[u16] {
        &self.0
    }

    /// `s.length` do JS: número de unidades UTF-16 (um astral conta 2).
    pub fn units(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Anexa o conteúdo de outro `JsText` (concatenação crua de unidades).
    pub fn push(&mut self, other: &Self) {
        self.0.extend_from_slice(&other.0);
    }

    /// Anexa uma string válida em UTF-8 (o JS a codifica em unidades UTF-16).
    pub fn push_str(&mut self, s: &str) {
        self.0.extend(s.encode_utf16());
    }

    /// `s.slice(0, max_units)` do JS: corta em unidades UTF-16 e PODE deixar um
    /// surrogate órfão na fronteira (é o quirk que o golden exige preservar).
    pub fn js_slice(&self, max_units: usize) -> Self {
        let end = max_units.min(self.0.len());
        Self(self.0[..end].to_vec())
    }

    /// `true` quando toda unidade é escalar Unicode válido (nenhum surrogate
    /// órfão). Só um texto bem formado tem conversão estrita para `String`.
    pub fn is_well_formed(&self) -> bool {
        let mut i = 0;
        while i < self.0.len() {
            let u = self.0[i];
            if (0xD800..=0xDBFF).contains(&u) {
                match self.0.get(i + 1) {
                    Some(&lo) if (0xDC00..=0xDFFF).contains(&lo) => i += 2,
                    _ => return false,
                }
            } else if (0xDC00..=0xDFFF).contains(&u) {
                return false;
            } else {
                i += 1;
            }
        }
        true
    }

    /// `JSON.stringify(s)` do JS: aspas, escapes de controle, o astral cru em
    /// UTF-8 e o surrogate ÓRFÃO escapado como `\uXXXX` minúsculo. É o mesmo
    /// contrato de `expectedJson` no golden.
    pub fn js_stringify(&self) -> String {
        let mut out = String::with_capacity(self.0.len() + 2);
        out.push('"');
        let mut i = 0;
        while i < self.0.len() {
            let u = self.0[i];
            if (0xD800..=0xDBFF).contains(&u) && is_low_surrogate(self.0.get(i + 1).copied()) {
                let lo = self.0[i + 1];
                let cp = 0x1_0000 + ((u as u32 - 0xD800) << 10) + (lo as u32 - 0xDC00);
                if let Some(c) = char::from_u32(cp) {
                    push_json_char(&mut out, c);
                }
                i += 2;
                continue;
            }
            if (0xD800..=0xDFFF).contains(&u) {
                out.push_str(&format!("\\u{u:04x}"));
            } else if let Some(c) = char::from_u32(u as u32) {
                push_json_char(&mut out, c);
            }
            i += 1;
        }
        out.push('"');
        out
    }

    /// Conteúdo de um literal de string JSON (`raw` SEM as aspas externas),
    /// decodificando `\uXXXX` inclusive de surrogate órfão — como o
    /// `JSON.parse` do Node, que aceita `"\uD83D"` sozinho (o `serde_json`
    /// estrito recusaria). `None` para escape malformado.
    pub fn from_json_string_literal(raw: &str) -> Option<Self> {
        let mut out: Vec<u16> = Vec::with_capacity(raw.len());
        let mut it = raw.chars();
        while let Some(c) = it.next() {
            if c != '\\' {
                push_char_units(&mut out, c);
                continue;
            }
            match it.next()? {
                '"' => out.push('"' as u16),
                '\\' => out.push('\\' as u16),
                '/' => out.push('/' as u16),
                'b' => out.push(0x08),
                'f' => out.push(0x0C),
                'n' => out.push(0x0A),
                'r' => out.push(0x0D),
                't' => out.push(0x09),
                'u' => {
                    let mut v: u32 = 0;
                    for _ in 0..4 {
                        v = v * 16 + it.next()?.to_digit(16)?;
                    }
                    out.push(v as u16);
                }
                _ => return None,
            }
        }
        Some(Self(out))
    }
}

fn is_low_surrogate(unit: Option<u16>) -> bool {
    matches!(unit, Some(u) if (0xDC00..=0xDFFF).contains(&u))
}

/// Anexa um escalar Unicode como unidades UTF-16 (par surrogate se astral).
fn push_char_units(out: &mut Vec<u16>, c: char) {
    let cp = c as u32;
    if cp > 0xFFFF {
        let v = cp - 0x1_0000;
        out.push(0xD800 + (v >> 10) as u16);
        out.push(0xDC00 + (v & 0x3FF) as u16);
    } else {
        out.push(cp as u16);
    }
}

/// Fugas de `JSON.stringify`: `"`/`\`, os atalhos `\b\f\n\r\t` e `\u00xx` para
/// os demais de controle; todo o resto sai cru em UTF-8.
fn push_json_char(out: &mut String, c: char) {
    match c {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\u{8}' => out.push_str("\\b"),
        '\u{c}' => out.push_str("\\f"),
        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
        c => out.push(c),
    }
}
