//! Busca do ApacheTorrent (`resolvers/profiles/apachetorrent.ts`): a home dá
//! o token do form e o cookie de sessão; a busca vai em
//! `/index.php?busca=&token=&hp_bot_check=` com redirect MANUAL — o 302 para a
//! home é a prova de sessão morta e renova a sessão uma vez; 301 que mantém a
//! busca no `Location` é canonicalização de domínio e é seguido.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use reqwest::header::{ACCEPT, COOKIE, LOCATION, SET_COOKIE, USER_AGENT};
use reqwest::redirect::Policy;
use tokio::sync::Mutex;
use url::Url;

use crate::common::encode_uri_component;
use crate::common::SearchItem;
use crate::profile::ResolverProfile;
use crate::search_select;
use crate::sites::apachetorrent::extract_search_token;
use crate::sites::site_output;

const HTML_ACCEPT: &str = "text/html,application/xhtml+xml";

/// Sessão do site (cookie + token do form). Um profile Apache por processo.
#[derive(Clone, Default)]
struct Session {
    cookie: String,
    token: String,
}

static SESSION: LazyLock<Mutex<Option<Session>>> = LazyLock::new(|| Mutex::new(None));

static PHPSESSID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)PHPSESSID=([^;\s,]+)").expect("PHPSESSID"));
static OPEN_SEARCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<input(?-u:\b)[^>]*(?-u:\b)name=["']busca["']"#).expect("campo busca")
});
static BUSCA_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)busca=").expect("busca="));
static PAIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^=;]+=").expect("par"));

/// `extractSessionCookie`: o PHPSESSID, senão os pares `nome=valor` de todos
/// os `Set-Cookie`.
fn session_cookie(response: &reqwest::Response) -> String {
    let raw: Vec<&str> = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    let joined = raw.join(", ");
    if let Some(c) = PHPSESSID.captures(&joined) {
        return format!("PHPSESSID={}", &c[1]);
    }
    raw.iter()
        .map(|chunk| chunk.split(';').next().unwrap_or("").trim().to_string())
        .filter(|pair| PAIR.is_match(pair))
        .collect::<Vec<_>>()
        .join("; ")
}

fn client(profile: &ResolverProfile, follow: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(if follow {
            Policy::limited(10)
        } else {
            Policy::none()
        })
        .timeout(Duration::from_millis(profile.network.timeout_ms))
        .build()
        .map_err(|e| e.to_string())
}

fn http_err(status: reqwest::StatusCode) -> String {
    format!("http_{}", status.as_u16())
}

async fn fetch_home(profile: &ResolverProfile) -> Result<(String, String), String> {
    let url = format!("{}/", profile.selector.url());
    profile
        .allowlist
        .assert_allowed_url(&url)
        .map_err(|e| e.to_string())?;
    let res = client(profile, true)?
        .get(&url)
        .header(USER_AGENT, &profile.network.user_agent)
        .header(ACCEPT, HTML_ACCEPT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(http_err(res.status()));
    }
    let cookie = session_cookie(&res);
    let html = res.text().await.map_err(|e| e.to_string())?;
    Ok((html, cookie))
}

async fn ensure_session(profile: &ResolverProfile, force: bool) -> Result<Session, String> {
    let mut guard = SESSION.lock().await;
    if let (Some(s), false) = (guard.as_ref(), force) {
        return Ok(s.clone());
    }
    let (html, cookie) = fetch_home(profile).await?;
    let session = match extract_search_token(&html) {
        Some(token) => {
            if cookie.is_empty() {
                return Err("session_failed".into());
            }
            Session { cookie, token }
        }
        None if OPEN_SEARCH.is_match(&html) => Session::default(),
        None => return Err("session_failed".into()),
    };
    *guard = Some(session.clone());
    Ok(session)
}

fn search_url(profile: &ResolverProfile, s: &Session, query: &str) -> String {
    let busca = format!(
        "{}/index.php?busca={}",
        profile.selector.url(),
        encode_uri_component(query)
    );
    if s.token.is_empty() {
        return busca;
    }
    // `hp_bot_check` vai VAZIO, como o form da home: o site devolve 302 quando
    // o campo chega preenchido.
    format!(
        "{busca}&token={}&hp_bot_check=",
        encode_uri_component(&s.token)
    )
}

async fn request(
    profile: &ResolverProfile,
    s: &Session,
    url: &str,
) -> Result<reqwest::Response, String> {
    profile
        .allowlist
        .assert_allowed_url(url)
        .map_err(|e| e.to_string())?;
    let mut req = client(profile, false)?
        .get(url)
        .header(USER_AGENT, &profile.network.user_agent)
        .header(ACCEPT, HTML_ACCEPT);
    if !s.cookie.is_empty() {
        req = req.header(COOKIE, &s.cookie);
    }
    req.send().await.map_err(|e| e.to_string())
}

/// `fetchSearchHtml`: até 2 resoluções de redirect, renovando a sessão uma vez.
async fn fetch_search_html(profile: &ResolverProfile, query: &str) -> Result<String, String> {
    let mut current = ensure_session(profile, false).await?;
    let mut res = request(profile, &current, &search_url(profile, &current, query)).await?;
    let mut refreshed = false;
    for _ in 0..2 {
        if !res.status().is_redirection() {
            break;
        }
        let location = res
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !location.is_empty() && BUSCA_PARAM.is_match(&location) {
            let next = Url::parse(&profile.selector.url())
                .and_then(|b| b.join(&location))
                .map_err(|e| e.to_string())?;
            res = request(profile, &current, next.as_str()).await?;
        } else {
            if refreshed {
                break;
            }
            refreshed = true;
            current = ensure_session(profile, true).await?;
            res = request(profile, &current, &search_url(profile, &current, query)).await?;
        }
    }
    if res.status().is_redirection() {
        return Err("session_rejected".into());
    }
    if !res.status().is_success() {
        return Err(http_err(res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

/// `searchPosts` do Apache: busca com sessão → seleção → botões de cada post.
pub async fn search_items(
    profile: &ResolverProfile,
    query: &str,
) -> Result<Vec<SearchItem>, String> {
    let site = site_output(&profile.site_name).ok_or("site_sem_saida")?;
    let rules = search_select::rules_for(&profile.site_name);
    let season = search_select::requested_season(query);
    let normalized = search_select::normalize_query(query, rules);
    let html = match fetch_search_html(profile, &normalized).await {
        Ok(html) => {
            profile.selector.note_success();
            html
        }
        Err(e) => {
            profile.account_failure(&e).await;
            return Err(e);
        }
    };
    let posts = site.search_posts(&html, &profile.selector.url());
    let posts = site.select_posts(posts, &normalized, season, rules.max_posts);
    profile.items_for_posts(posts, season).await
}
