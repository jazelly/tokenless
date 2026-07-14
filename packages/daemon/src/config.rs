use crate::{DaemonError, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use url::Host;

pub const CONFIG_PROTOCOL: &str = "tokenless.config.v1";
pub const CONFIG_FILE_NAME: &str = "config.json";

const SUPPORTED_PROVIDERS: &[&str] = &["chatgpt", "claude", "gemini", "grok"];
const SUPPORTED_BROWSERS: &[&str] = &[
    "chrome",
    "chrome-for-testing",
    "chromium",
    "edge",
    "arc",
    "brave",
    "profile",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenlessConfig {
    pub protocol: String,
    pub updated_at: Option<String>,
    #[serde(default)]
    pub preferred_providers: Vec<String>,
    pub browser: Option<String>,
    pub daemon_url: Option<String>,
}

impl Default for TokenlessConfig {
    fn default() -> Self {
        Self {
            protocol: CONFIG_PROTOCOL.to_owned(),
            updated_at: None,
            preferred_providers: Vec::new(),
            browser: None,
            daemon_url: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConfigUpdate {
    pub preferred_providers: Option<Vec<String>>,
    /// `None` preserves the current value; `Some(None)` explicitly clears it.
    pub browser: Option<Option<String>>,
    /// `None` preserves the current value; `Some(None)` explicitly clears it.
    pub daemon_url: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(home_dir: &Path) -> Self {
        Self {
            path: home_dir.join(CONFIG_FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> Result<TokenlessConfig> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(TokenlessConfig::default())
            }
            Err(error) => return Err(error.into()),
        };
        let mut config: TokenlessConfig = serde_json::from_slice(&bytes)?;
        if config.protocol != CONFIG_PROTOCOL {
            return Err(DaemonError::InvalidInput(format!(
                "{} has unsupported config protocol {}",
                self.path.display(),
                config.protocol
            )));
        }
        config.preferred_providers = normalize_providers(config.preferred_providers);
        config.browser = normalize_optional_browser(config.browser)?;
        config.daemon_url = normalize_optional_daemon_url(config.daemon_url)?;
        Ok(config)
    }

    pub fn write(&self, update: ConfigUpdate) -> Result<TokenlessConfig> {
        let parent = self.path.parent().ok_or_else(|| {
            DaemonError::InvalidInput(format!("{} has no parent directory", self.path.display()))
        })?;
        fs::create_dir_all(parent)?;
        let lock_path = self.path.with_extension("json.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        open_secure_file(&mut options);
        let lock = options.open(&lock_path)?;
        crate::restrict_file_permissions(&lock_path)?;
        lock.lock_exclusive()?;
        let current = self.read()?;
        let config = TokenlessConfig {
            protocol: CONFIG_PROTOCOL.to_owned(),
            updated_at: Some(crate::now_rfc3339()),
            preferred_providers: update
                .preferred_providers
                .map(normalize_providers)
                .unwrap_or(current.preferred_providers),
            browser: match update.browser {
                Some(value) => normalize_optional_browser(value)?,
                None => current.browser,
            },
            daemon_url: match update.daemon_url {
                Some(value) => normalize_optional_daemon_url(value)?,
                None => current.daemon_url,
            },
        };
        write_json_atomic_secure(&self.path, &config)?;
        Ok(config)
    }
}

#[cfg(unix)]
fn open_secure_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn open_secure_file(_options: &mut OpenOptions) {}

fn normalize_providers(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let provider = value.trim().to_ascii_lowercase();
        if SUPPORTED_PROVIDERS.contains(&provider.as_str()) && !normalized.contains(&provider) {
            normalized.push(provider);
        }
    }
    normalized
}

fn normalize_optional_browser(value: Option<String>) -> Result<Option<String>> {
    value.map(|value| normalize_browser(&value)).transpose()
}

fn normalize_browser(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase().replace(['_', ' '], "-");
    let normalized = match normalized.as_str() {
        "google-chrome" | "googlechrome" => "chrome",
        "chrome-testing" | "chrome-for-testing" => "chrome-for-testing",
        "chrome-for-testing-legacy" => "chrome-for-testing",
        "chromium-browser" => "chromium",
        "microsoft-edge" | "msedge" => "edge",
        "brave-browser" => "brave",
        other => other,
    };
    if SUPPORTED_BROWSERS.contains(&normalized) {
        Ok(normalized.to_owned())
    } else {
        Err(DaemonError::InvalidInput(format!(
            "unsupported browser: {value}"
        )))
    }
}

fn normalize_optional_daemon_url(value: Option<String>) -> Result<Option<String>> {
    value.map(|value| normalize_daemon_url(&value)).transpose()
}

fn normalize_daemon_url(value: &str) -> Result<String> {
    let normalized = value.trim().trim_end_matches('/');
    if normalized.len() > 2_048 {
        return Err(DaemonError::InvalidInput(
            "daemonUrl must not exceed 2048 bytes".to_owned(),
        ));
    }
    let parsed = url::Url::parse(normalized).map_err(|error| {
        DaemonError::InvalidInput(format!(
            "daemonUrl must be a valid loopback HTTP URL: {error}"
        ))
    })?;
    let loopback = match parsed.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() != "http"
        || !loopback
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(DaemonError::InvalidInput(
            "daemonUrl must be an unauthenticated loopback HTTP URL".to_owned(),
        ));
    }
    Ok(normalized.to_owned())
}

pub(crate) fn write_json_atomic_secure<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        DaemonError::InvalidInput(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".tokenless-state-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    crate::restrict_file_permissions(temporary.path())?;
    let mut body = serde_json::to_vec_pretty(value)?;
    body.push(b'\n');
    temporary.write_all(&body)?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| DaemonError::Io(error.error))?;
    crate::restrict_file_permissions(path)?;
    sync_parent_directory(parent)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<()> {
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_config_updates_preserve_and_normalize_fields() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(tempdir.path());
        let written = store
            .write(ConfigUpdate {
                preferred_providers: Some(vec![
                    " Claude ".to_owned(),
                    "chatgpt".to_owned(),
                    "GROK".to_owned(),
                    "claude".to_owned(),
                    "unsupported".to_owned(),
                ]),
                browser: Some(Some("google-chrome".to_owned())),
                daemon_url: Some(Some("http://127.0.0.1:7331/".to_owned())),
            })
            .unwrap();
        assert_eq!(written.preferred_providers, ["claude", "chatgpt", "grok"]);
        assert_eq!(written.browser.as_deref(), Some("chrome"));
        assert_eq!(written.daemon_url.as_deref(), Some("http://127.0.0.1:7331"));

        let updated = store
            .write(ConfigUpdate {
                preferred_providers: Some(vec!["gemini".to_owned(), "grok".to_owned()]),
                ..ConfigUpdate::default()
            })
            .unwrap();
        assert_eq!(updated.preferred_providers, ["gemini", "grok"]);
        assert_eq!(updated.browser.as_deref(), Some("chrome"));
        assert_eq!(updated.daemon_url.as_deref(), Some("http://127.0.0.1:7331"));
    }

    #[test]
    fn config_write_is_secure_and_read_rejects_wrong_protocol() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(tempdir.path());
        store.write(ConfigUpdate::default()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        fs::write(
            store.path(),
            r#"{"protocol":"tokenless.config.v999","updatedAt":null,"preferredProviders":[],"browser":null,"daemonUrl":null}"#,
        )
        .unwrap();
        assert!(matches!(store.read(), Err(DaemonError::InvalidInput(_))));
    }

    #[test]
    fn legacy_chrome_for_testing_config_is_canonicalized() {
        assert_eq!(
            normalize_browser("chrome-for-testing-legacy").unwrap(),
            "chrome-for-testing"
        );
    }
}
