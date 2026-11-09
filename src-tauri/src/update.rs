//! "Is there a newer postmortem?" – asks GitHub for the latest published release.

use serde::{Deserialize, Serialize};

use crate::lichess::client;

const LATEST: &str = "https://api.github.com/repos/event173/postmortem/releases/latest";
pub const RELEASES_PAGE: &str = "https://github.com/event173/postmortem/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    /// Newest published version, if GitHub could be reached.
    pub latest: Option<String>,
    pub available: bool,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// "v0.1.10" -> [0, 1, 10]
fn parse(v: &str) -> Option<Vec<u64>> {
    v.trim().trim_start_matches('v').split('.').map(|p| p.parse().ok()).collect()
}

pub fn newer(latest: &str, current: &str) -> bool {
    match (parse(latest), parse(current)) {
        (Some(l), Some(c)) => l > c,
        _ => false,
    }
}

pub async fn check() -> AppUpdate {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let latest = async {
        let resp = client()
            .ok()?
            .get(LATEST)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let r: Release = resp.json().await.ok()?;
        (!r.draft && !r.prerelease).then(|| r.tag_name.trim_start_matches('v').to_string())
    }
    .await;
    let available = latest.as_deref().is_some_and(|l| newer(l, &current));
    AppUpdate { current, latest, available }
}

/// Open the release page in the system browser.
pub fn open_releases_page() -> Result<(), String> {
    open_in_browser(RELEASES_PAGE)
}

/// Open a web page in the system browser.
pub fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(url);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| crate::tr!("Browser konnte nicht geöffnet werden: {e}", "Could not open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions_numerically() {
        assert!(newer("0.1.10", "0.1.9"));
        assert!(newer("v0.2.0", "0.1.7"));
        assert!(!newer("0.1.7", "0.1.7"));
        assert!(!newer("0.1.6", "0.1.7"));
        assert!(!newer("garbage", "0.1.7"));
    }
}
