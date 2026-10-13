// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    collections::HashMap,
    ffi::OsString,
    io::Cursor,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

#[cfg(not(target_os = "macos"))]
use std::ffi::OsStr;

use base64::Engine;
use futures_util::StreamExt;
use http::{header::ACCEPT, HeaderName};
use minisign_verify::{PublicKey, Signature};
use percent_encoding::{AsciiSet, CONTROLS};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    ClientBuilder, StatusCode,
};
use semver::Version;
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use tauri::{
    utils::{
        config::BundleType,
        platform::{bundle_type, current_exe},
    },
    AppHandle, Resource, Runtime,
};
use time::OffsetDateTime;
use url::Url;

use crate::{
    error::{Error, Result},
    Config,
};

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "macos"
))]
#[path = "appimage_install.rs"]
mod appimage_install;

#[cfg(all(
    feature = "zip",
    any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "macos"
    )
))]
#[path = "appimage_archive.rs"]
mod appimage_archive;

const UPDATER_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

#[derive(Copy, Clone)]
pub enum Installer {
    AppImage,
    Deb,
    Rpm,

    App,

    Msi,
    Nsis,
}

impl Installer {
    fn name(self) -> &'static str {
        match self {
            Self::AppImage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::App => "app",
            Self::Msi => "msi",
            Self::Nsis => "nsis",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReleaseManifestPlatform {
    /// Download URL for the platform
    pub url: Url,
    /// Signature for the platform
    pub signature: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum RemoteReleaseInner {
    Dynamic(ReleaseManifestPlatform),
    Static {
        platforms: HashMap<String, ReleaseManifestPlatform>,
    },
}

/// Information about a release returned by the remote update server.
///
/// This type can have one of two shapes: Server Format (Dynamic Format) and Static Format.
#[derive(Debug, Clone)]
pub struct RemoteRelease {
    /// Version to install.
    pub version: Version,
    /// Release notes.
    pub notes: Option<String>,
    /// Release date.
    pub pub_date: Option<OffsetDateTime>,
    /// Release data.
    pub data: RemoteReleaseInner,
}

impl RemoteRelease {
    /// The release's download URL for the given target.
    pub fn download_url(&self, target: &str) -> Result<&Url> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.url),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |p| {
                    Ok(&p.url)
                }),
        }
    }

    /// The release's signature for the given target.
    pub fn signature(&self, target: &str) -> Result<&String> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.signature),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |platform| {
                    Ok(&platform.signature)
                }),
        }
    }
}

pub type OnBeforeExit = Arc<dyn Fn() -> std::result::Result<(), String> + Send + Sync + 'static>;
type OnWindowsInstallerLaunched = Arc<dyn Fn() + Send + Sync + 'static>;
pub type OnBeforeRequest = Arc<dyn Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>;
pub type VersionComparator = Arc<dyn Fn(Version, RemoteRelease) -> bool + Send + Sync>;
fn run_preinstall_flush(
    hook: Option<&OnBeforeExit>,
    install: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if let Some(hook) = hook {
        hook().map_err(Error::BeforeExit)?;
    }
    install()
}

#[cfg(any(windows, test))]
fn finish_windows_installer_launch(
    shell_result: isize,
    cleanup: impl FnOnce(),
    exit: impl FnOnce(),
) -> Result<()> {
    if !crate::install_safety::shell_execute_launch_ok(shell_result) {
        return Err(Error::Io(std::io::Error::other(format!(
            "failed to launch updater installer (ShellExecuteW={shell_result})"
        ))));
    }
    cleanup();
    exit();
    Ok(())
}

const MAX_UPDATE_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

fn validate_download_content_length(content_length: Option<u64>, limit: u64) -> Result<()> {
    if content_length.is_some_and(|length| length > limit) {
        return Err(Error::Network(format!(
            "update package exceeds the {} byte download limit",
            limit
        )));
    }
    Ok(())
}

fn append_download_chunk(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    content_length: Option<u64>,
    limit: u64,
) -> Result<()> {
    validate_download_content_length(content_length, limit)?;
    let current = u64::try_from(buffer.len()).map_err(|_| {
        Error::Network("update package size exceeds the supported limit".to_string())
    })?;
    let chunk_size = u64::try_from(chunk.len()).map_err(|_| {
        Error::Network("update package size exceeds the supported limit".to_string())
    })?;
    let next = current.checked_add(chunk_size).ok_or_else(|| {
        Error::Network("update package size exceeds the supported limit".to_string())
    })?;
    if next > limit {
        return Err(Error::Network(format!(
            "update package exceeds the {} byte download limit",
            limit
        )));
    }
    if content_length.is_some_and(|length| next > length) {
        return Err(Error::Network(
            "update response exceeded its Content-Length".to_string(),
        ));
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

type MainThreadClosure = Box<dyn FnOnce() + Send + Sync + 'static>;
type RunOnMainThread =
    Box<dyn Fn(MainThreadClosure) -> std::result::Result<(), tauri::Error> + Send + Sync + 'static>;

pub struct UpdaterBuilder {
    #[allow(dead_code)]
    run_on_main_thread: RunOnMainThread,
    app_name: String,
    bundle_identifier: String,
    current_version: Version,
    config: Config,
    pub(crate) version_comparator: Option<VersionComparator>,
    executable_path: Option<PathBuf>,
    target: Option<String>,
    endpoints: Option<Vec<Url>>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    installer_args: Vec<OsString>,
    current_exe_args: Vec<OsString>,
    on_before_exit: Option<OnBeforeExit>,
    on_windows_installer_launched: Option<OnWindowsInstallerLaunched>,
    configure_client: Option<OnBeforeRequest>,
}

impl UpdaterBuilder {
    pub(crate) fn new<R: Runtime>(app: &AppHandle<R>, config: crate::Config) -> Self {
        let app_ = app.clone();
        let run_on_main_thread = move |f| app_.run_on_main_thread(f);
        Self {
            run_on_main_thread: Box::new(run_on_main_thread),
            installer_args: config
                .windows
                .as_ref()
                .map(|w| w.installer_args.clone())
                .unwrap_or_default(),
            current_exe_args: Vec::new(),
            app_name: app.package_info().name.clone(),
            bundle_identifier: app.config().identifier.clone(),
            current_version: app.package_info().version.clone(),
            config,
            version_comparator: None,
            executable_path: None,
            target: None,
            endpoints: None,
            headers: Default::default(),
            timeout: None,
            proxy: None,
            no_proxy: false,
            on_before_exit: None,
            on_windows_installer_launched: None,
            configure_client: None,
        }
    }

    pub fn version_comparator<F: Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.version_comparator = Some(Arc::new(f));
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target.replace(target.into());
        self
    }

    pub fn endpoints(mut self, endpoints: Vec<Url>) -> Result<Self> {
        crate::config::validate_endpoints(
            &endpoints,
            self.config.dangerous_insecure_transport_protocol,
        )?;

        self.endpoints.replace(endpoints);
        Ok(self)
    }

    pub fn executable_path<P: AsRef<Path>>(mut self, p: P) -> Self {
        self.executable_path.replace(p.as_ref().into());
        self
    }

    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> =
            value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);

        Ok(self)
    }

    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    pub fn clear_headers(mut self) -> Self {
        self.headers.clear();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn proxy(mut self, proxy: Url) -> Self {
        self.proxy.replace(proxy);
        self
    }

    /// Clear all proxies. See [`reqwest::ClientBuilder::no_proxy`](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.no_proxy).
    pub fn no_proxy(mut self) -> Self {
        self.no_proxy = true;
        self
    }

    pub fn pubkey<S: Into<String>>(mut self, pubkey: S) -> Self {
        self.config.pubkey = pubkey.into();
        self
    }

    /// Adds an argument to pass to the Windows installer.
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        self.installer_args.push(arg.into());
        self
    }

    /// Adds multiple arguments to pass to the Windows installer.
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.installer_args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Removes all the additional arguments to pass to the Windows installer.
    ///
    /// Note: this only removes the additional arguments added through
    /// [`Self::installer_arg`], [`crate::Builder::installer_arg`]
    /// and the `plugins > updater > windows > installerArgs` config,
    /// not the ones managed by us (e.g. `/UPDATER` flag passed to the NSIS installer)
    pub fn clear_installer_args(mut self) -> Self {
        self.installer_args.clear();
        self
    }

    /// Fallible preparation to run before installing an update. Returning an
    /// error aborts installation and keeps the downloaded update retryable.
    pub fn on_before_exit<F: Fn() -> std::result::Result<(), String> + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.on_before_exit.replace(Arc::new(f));
        self
    }

    pub(crate) fn on_windows_installer_launched<F: Fn() + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.on_windows_installer_launched = Some(Arc::new(f));
        self
    }

    /// Allows you to modify the `reqwest` client builder before the HTTP request is sent.
    ///
    /// Note that `reqwest` crate may be updated in minor releases of tauri-plugin-updater.
    /// Therefore it's recommended to pin the plugin to at least a minor version when you're using `configure_client`.
    pub fn configure_client<F: Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.configure_client.replace(Arc::new(f));
        self
    }

    pub fn build(self) -> Result<Updater> {
        let endpoints = self
            .endpoints
            .unwrap_or_else(|| self.config.endpoints.clone());

        if endpoints.is_empty() {
            return Err(Error::EmptyEndpoints);
        };

        let arch = updater_arch().ok_or(Error::UnsupportedArch)?;

        let executable_path = self.executable_path.clone().unwrap_or(current_exe()?);
        let executable_name = executable_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned);

        // Get the extract_path from the provided executable_path
        let extract_path = if cfg!(target_os = "linux") {
            executable_path
        } else {
            extract_path_from_executable(&executable_path)?
        };

        Ok(Updater {
            run_on_main_thread: Arc::new(self.run_on_main_thread),
            config: self.config,
            app_name: self.app_name,
            bundle_identifier: self.bundle_identifier,
            executable_name,
            current_version: self.current_version,
            version_comparator: self.version_comparator,
            timeout: self.timeout,
            proxy: self.proxy,
            no_proxy: self.no_proxy,
            endpoints,
            installer_args: self.installer_args,
            current_exe_args: self.current_exe_args,
            arch,
            target: self.target,
            headers: self.headers,
            extract_path,
            on_before_exit: self.on_before_exit,
            on_windows_installer_launched: self.on_windows_installer_launched,
            configure_client: self.configure_client,
        })
    }
}

impl UpdaterBuilder {
    pub(crate) fn current_exe_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.current_exe_args
            .extend(args.into_iter().map(Into::into));
        self
    }
}

pub struct Updater {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    app_name: String,
    bundle_identifier: String,
    executable_name: Option<String>,
    current_version: Version,
    version_comparator: Option<VersionComparator>,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    endpoints: Vec<Url>,
    arch: &'static str,
    // The `{{target}}` variable we replace in the endpoint and serach for in the JSON,
    // this is either the user provided target or the current operating system by default
    target: Option<String>,
    headers: HeaderMap,
    extract_path: PathBuf,
    on_before_exit: Option<OnBeforeExit>,
    on_windows_installer_launched: Option<OnWindowsInstallerLaunched>,
    configure_client: Option<OnBeforeRequest>,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
}

impl Updater {
    pub async fn check(&self) -> Result<Option<Update>> {
        // we want JSON only
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        }

        // Set SSL certs for linux if they aren't available.
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("SSL_CERT_FILE").is_none() {
                for candidate in [
                    "/etc/ssl/certs/ca-certificates.crt",
                    "/etc/pki/tls/certs/ca-bundle.crt",
                ] {
                    if std::path::Path::new(candidate).is_file() {
                        std::env::set_var("SSL_CERT_FILE", candidate);
                        break;
                    }
                }
            }
            if std::env::var_os("SSL_CERT_DIR").is_none() {
                std::env::set_var("SSL_CERT_DIR", "/etc/ssl/certs");
            }
        }
        let target = if let Some(target) = &self.target {
            target
        } else {
            updater_os().ok_or(Error::UnsupportedOs)?
        };

        let mut remote_release: Option<RemoteRelease> = None;
        let mut raw_json: Option<serde_json::Value> = None;
        let mut last_error: Option<Error> = None;
        for url in &self.endpoints {
            // replace {{current_version}}, {{target}}, {{arch}} and {{bundle_type}} in the provided URL
            // this is useful if we need to query example
            // https://releases.myapp.com/update/{{target}}/{{arch}}/{{current_version}}
            // will be translated into ->
            // https://releases.myapp.com/update/darwin/aarch64/1.0.0
            // The main objective is if the update URL is defined via the Cargo.toml
            // the URL will be generated dynamically
            let version = self.current_version.to_string();
            let version = version.as_bytes();
            const CONTROLS_ADD: &AsciiSet = &CONTROLS.add(b'+');
            let encoded_version = percent_encoding::percent_encode(version, CONTROLS_ADD);
            let encoded_version = encoded_version.to_string();
            let installer = installer_for_bundle_type(bundle_type())
                .map(|i| i.name())
                .unwrap_or("unknown");

            let url: Url = url
                .to_string()
                // url::Url automatically url-encodes the path components
                .replace("%7B%7Bcurrent_version%7D%7D", &encoded_version)
                .replace("%7B%7Btarget%7D%7D", target)
                .replace("%7B%7Barch%7D%7D", self.arch)
                .replace("%7B%7Bbundle_type%7D%7D", installer)
                // but not query parameters
                .replace("{{current_version}}", &encoded_version)
                .replace("{{target}}", target)
                .replace("{{arch}}", self.arch)
                .replace("{{bundle_type}}", installer)
                .parse()?;

            log::debug!("checking for updates {url}");

            #[cfg(feature = "rustls-tls")]
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                // This can only fail if there is already a default provider which we checked for already.
                let _ = rustls::crypto::ring::default_provider().install_default();
            }

            let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
            if self.config.dangerous_accept_invalid_certs {
                request = request.danger_accept_invalid_certs(true);
            }
            if self.config.dangerous_accept_invalid_hostnames {
                request = request.danger_accept_invalid_hostnames(true);
            }
            if let Some(timeout) = self.timeout {
                request = request.timeout(timeout);
            }
            if self.no_proxy {
                log::debug!("disabling proxy");
                request = request.no_proxy();
            } else if let Some(ref proxy) = self.proxy {
                log::debug!("using proxy {proxy}");
                let proxy = reqwest::Proxy::all(proxy.as_str())?;
                request = request.proxy(proxy);
            }

            if let Some(ref configure_client) = self.configure_client {
                request = configure_client(request);
            }

            let response = request
                .build()?
                .get(url)
                .headers(headers.clone())
                .send()
                .await;

            match response {
                Ok(res) => {
                    if res.status().is_success() {
                        // no updates found!
                        if StatusCode::NO_CONTENT == res.status() {
                            log::debug!("update endpoint returned 204 No Content");
                            return Ok(None);
                        };

                        let update_response: serde_json::Value = res.json().await?;
                        log::debug!("update response: {update_response:?}");
                        raw_json = Some(update_response.clone());
                        match serde_json::from_value::<RemoteRelease>(update_response)
                            .map_err(Into::into)
                        {
                            Ok(release) => {
                                log::debug!("parsed release response {release:?}");
                                last_error = None;
                                remote_release = Some(release);
                                // we found a release, break the loop
                                break;
                            }
                            Err(err) => {
                                log::error!("failed to deserialize update response: {err}");
                                last_error = Some(err)
                            }
                        }
                    } else {
                        log::error!(
                            "update endpoint did not respond with a successful status code"
                        );
                    }
                }
                Err(err) => {
                    log::error!("failed to check for updates: {err}");
                    last_error = Some(err.into())
                }
            }
        }

        // Last error is cleaned on success.
        // Shouldn't be triggered if we had a successfull call
        if let Some(error) = last_error {
            return Err(error);
        }

        // Extracted remote metadata
        let release = remote_release.ok_or(Error::ReleaseNotFound)?;

        let should_update = match self.version_comparator.as_ref() {
            Some(comparator) => comparator(self.current_version.clone(), release.clone()),
            None => release.version > self.current_version,
        };

        let installer = installer_for_bundle_type(bundle_type());
        let (download_url, signature) = self.get_urls(&release, &installer)?;

        let update = if should_update {
            Some(Update {
                run_on_main_thread: self.run_on_main_thread.clone(),
                config: self.config.clone(),
                on_before_exit: self.on_before_exit.clone(),
                on_windows_installer_launched: self.on_windows_installer_launched.clone(),
                app_name: self.app_name.clone(),
                bundle_identifier: self.bundle_identifier.clone(),
                executable_name: self.executable_name.clone(),
                current_version: self.current_version.to_string(),
                target: target.to_owned(),
                extract_path: self.extract_path.clone(),
                version: release.version.to_string(),
                date: release.pub_date,
                download_url: download_url.clone(),
                signature: signature.to_owned(),
                body: release.notes,
                raw_json: raw_json.unwrap(),
                timeout: None,
                proxy: self.proxy.clone(),
                no_proxy: self.no_proxy,
                headers: self.headers.clone(),
                installer_args: self.installer_args.clone(),
                current_exe_args: self.current_exe_args.clone(),
                configure_client: self.configure_client.clone(),
            })
        } else {
            None
        };

        Ok(update)
    }

    fn get_urls<'a>(
        &self,
        release: &'a RemoteRelease,
        installer: &Option<Installer>,
    ) -> Result<(&'a Url, &'a String)> {
        // Use the user provided target
        if let Some(target) = &self.target {
            return Ok((release.download_url(target)?, release.signature(target)?));
        }

        // Or else we search for [`{os}-{arch}-{installer}`, `{os}-{arch}`] in order
        let os = updater_os().ok_or(Error::UnsupportedOs)?;
        let arch = self.arch;
        let mut targets = Vec::new();
        if let Some(installer) = installer {
            let installer = installer.name();
            targets.push(format!("{os}-{arch}-{installer}"));
        }
        targets.push(format!("{os}-{arch}"));

        for target in &targets {
            log::debug!("Searching for updater target '{target}' in release data");
            if let (Ok(download_url), Ok(signature)) =
                (release.download_url(target), release.signature(target))
            {
                return Ok((download_url, signature));
            };
        }

        Err(Error::TargetsNotFound(targets))
    }
}

#[derive(Clone)]
pub struct Update {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    #[allow(unused)]
    on_before_exit: Option<OnBeforeExit>,
    #[allow(unused)]
    on_windows_installer_launched: Option<OnWindowsInstallerLaunched>,
    /// Update description
    pub body: Option<String>,
    /// Version used to check for update
    pub current_version: String,
    /// Version announced
    pub version: String,
    /// Update publish date
    pub date: Option<OffsetDateTime>,
    /// The `{{target}}` variable we replace in the endpoint and search for in the JSON,
    /// this is either the user provided target or the current operating system by default
    pub target: String,
    /// Download URL announced
    pub download_url: Url,
    /// Signature announced
    pub signature: String,
    /// The raw version of server's JSON response. Useful if the response contains additional fields that the updater doesn't handle.
    pub raw_json: serde_json::Value,
    /// Request timeout
    pub timeout: Option<Duration>,
    /// Request proxy
    pub proxy: Option<Url>,
    /// Disable system proxy
    pub no_proxy: bool,
    /// Request headers
    pub headers: HeaderMap,
    /// Extract path
    #[allow(unused)]
    extract_path: PathBuf,
    /// App name, used for creating named tempfiles on Windows
    #[allow(unused)]
    app_name: String,
    #[allow(unused)]
    bundle_identifier: String,
    #[allow(unused)]
    executable_name: Option<String>,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
    configure_client: Option<OnBeforeRequest>,
}

impl Resource for Update {}

impl Update {
    /// Downloads the updater package, verifies it then return it as bytes.
    ///
    /// Use [`Update::install`] to install it
    pub async fn download<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        mut on_chunk: C,
        on_download_finish: D,
    ) -> Result<Vec<u8>> {
        // set our headers
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }

        let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
        if self.config.dangerous_accept_invalid_certs {
            request = request.danger_accept_invalid_certs(true);
        }
        if self.config.dangerous_accept_invalid_hostnames {
            request = request.danger_accept_invalid_hostnames(true);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        if self.no_proxy {
            request = request.no_proxy();
        } else if let Some(ref proxy) = self.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())?;
            request = request.proxy(proxy);
        }
        if let Some(ref configure_client) = self.configure_client {
            request = configure_client(request);
        }
        let response = request
            .build()?
            .get(self.download_url.clone())
            .headers(headers)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "Download request failed with status: {}",
                response.status()
            )));
        }

        let content_length: Option<u64> = response
            .headers()
            .get("Content-Length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        validate_download_content_length(content_length, MAX_UPDATE_PACKAGE_BYTES)?;

        let mut buffer = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            append_download_chunk(
                &mut buffer,
                chunk.as_ref(),
                content_length,
                MAX_UPDATE_PACKAGE_BYTES,
            )?;
            on_chunk(chunk.len(), content_length);
        }
        on_download_finish();

        verify_signature(&buffer, &self.signature, &self.config.pubkey)?;

        Ok(buffer)
    }

    /// Installs the updater package downloaded by [`Update::download`]
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        run_preinstall_flush(self.on_before_exit.as_ref(), || {
            self.install_inner(bytes.as_ref())
        })
    }

    /// Downloads and installs the updater package
    pub async fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> Result<()> {
        let bytes = self.download(on_chunk, on_download_finish).await?;
        self.install(bytes)
    }

    #[cfg(mobile)]
    fn install_inner(&self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
enum WindowsUpdaterType {
    Nsis {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
    Msi {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
}

#[cfg(windows)]
impl WindowsUpdaterType {
    fn nsis(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Nsis { path, temp }
    }

    fn msi(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Msi {
            path: path.wrap_in_quotes(),
            temp,
        }
    }
}

#[cfg(windows)]
impl Config {
    fn install_mode(&self) -> crate::config::WindowsUpdateInstallMode {
        self.windows
            .as_ref()
            .map(|w| w.install_mode.clone())
            .unwrap_or_default()
    }
}

/// Windows
#[cfg(windows)]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.msi              # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe        # NSIS installer
    /// ├── [AppName]_[version]_x64.msi.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64.msi           # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64-setup.exe           # NSIS installer
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use std::iter::once;
        use windows_sys::{
            w,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOW},
        };

        let updater_type = self.extract(bytes)?;

        let install_mode = self.config.install_mode();
        let current_args = &self.current_exe_args()[1..];
        let msi_args;
        let nsis_args;

        let installer_args: Vec<&OsStr> = match &updater_type {
            WindowsUpdaterType::Nsis { .. } => {
                nsis_args = current_args
                    .iter()
                    .map(escape_nsis_current_exe_arg)
                    .collect::<Vec<_>>();

                install_mode
                    .nsis_args()
                    .iter()
                    .map(OsStr::new)
                    .chain(once(OsStr::new("/UPDATE")))
                    .chain(once(OsStr::new("/ARGS")))
                    .chain(nsis_args.iter().map(OsStr::new))
                    .chain(self.installer_args())
                    .collect()
            }
            WindowsUpdaterType::Msi { path, .. } => {
                let escaped_args = current_args
                    .iter()
                    .map(escape_msi_property_arg)
                    .collect::<Vec<_>>()
                    .join(" ");
                msi_args = OsString::from(format!("LAUNCHAPPARGS=\"{escaped_args}\""));

                [OsStr::new("/i"), path.as_os_str()]
                    .into_iter()
                    .chain(install_mode.msiexec_args().iter().map(OsStr::new))
                    .chain(once(OsStr::new("/promptrestart")))
                    .chain(self.installer_args())
                    .chain(once(OsStr::new("AUTOLAUNCHAPP=True")))
                    .chain(once(msi_args.as_os_str()))
                    .collect()
            }
        };

        let file = match &updater_type {
            WindowsUpdaterType::Nsis { path, .. } => path.as_os_str().to_os_string(),
            WindowsUpdaterType::Msi { .. } => std::env::var("SYSTEMROOT").as_ref().map_or_else(
                |_| OsString::from("msiexec.exe"),
                |p| OsString::from(format!("{p}\\System32\\msiexec.exe")),
            ),
        };
        let file = encode_wide(file);

        let parameters = installer_args.join(OsStr::new(" "));
        let parameters = encode_wide(parameters);

        let launched = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                w!("open"),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                SW_SHOW,
            )
        } as isize;
        finish_windows_installer_launch(
            launched,
            || {
                if let Some(cleanup) = &self.on_windows_installer_launched {
                    cleanup();
                }
            },
            || std::process::exit(0),
        )
    }

    fn installer_args(&self) -> Vec<&OsStr> {
        self.installer_args
            .iter()
            .map(OsStr::new)
            .collect::<Vec<_>>()
    }

    fn current_exe_args(&self) -> Vec<&OsStr> {
        self.current_exe_args
            .iter()
            .map(OsStr::new)
            .collect::<Vec<_>>()
    }

    fn extract(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        #[cfg(feature = "zip")]
        if infer::archive::is_zip(bytes) {
            return self.extract_zip(bytes);
        }

        self.extract_exe(bytes)
    }

    fn make_temp_dir(&self) -> Result<PathBuf> {
        Ok(tempfile::Builder::new()
            .prefix(&format!("{}-{}-updater-", self.app_name, self.version))
            .tempdir()?
            .keep())
    }

    #[cfg(feature = "zip")]
    fn extract_zip(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        let temp_dir = self.make_temp_dir()?;

        let archive = Cursor::new(bytes);
        let mut extractor = zip::ZipArchive::new(archive)?;
        extractor.extract(&temp_dir)?;

        let paths = std::fs::read_dir(&temp_dir)?;
        for path in paths {
            let path = path?.path();
            let ext = path.extension();
            if ext == Some(OsStr::new("exe")) {
                return Ok(WindowsUpdaterType::nsis(path, None));
            } else if ext == Some(OsStr::new("msi")) {
                return Ok(WindowsUpdaterType::msi(path, None));
            }
        }

        Err(crate::Error::BinaryNotFoundInArchive)
    }

    fn extract_exe(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        if infer::app::is_exe(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".exe")?;
            Ok(WindowsUpdaterType::nsis(path, temp))
        } else if infer::archive::is_msi(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".msi")?;
            Ok(WindowsUpdaterType::msi(path, temp))
        } else {
            Err(crate::Error::InvalidUpdaterFormat)
        }
    }

    fn write_to_temp(
        &self,
        bytes: &[u8],
        ext: &str,
    ) -> Result<(PathBuf, Option<tempfile::TempPath>)> {
        use std::io::Write;

        let temp_dir = self.make_temp_dir()?;
        let mut temp_file = tempfile::Builder::new()
            .prefix(&format!("{}-{}-installer", self.app_name, self.version))
            .suffix(ext)
            .rand_bytes(0)
            .tempfile_in(temp_dir)?;
        temp_file.write_all(bytes)?;

        let temp = temp_file.into_temp_path();
        Ok((temp.to_path_buf(), Some(temp)))
    }
}

/// Linux (AppImage, Deb, RPM)
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_amd64.AppImage.tar.gz    # GZ generated by tauri-bundler
    /// │   └──[AppName]_[version]_amd64.AppImage        # Application AppImage
    /// ├── [AppName]_[version]_amd64.deb                # Debian package
    /// ├── [AppName]_[version]_amd64.rpm                # RPM package
    /// └── ...
    ///
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        match installer_for_bundle_type(bundle_type()) {
            Some(Installer::Deb) => self.install_deb(bytes),
            Some(Installer::Rpm) => self.install_rpm(bytes),
            _ => self.install_appimage(bytes),
        }
    }

    fn install_appimage(&self, bytes: &[u8]) -> Result<()> {
        #[cfg(feature = "zip")]
        let payload = if infer::archive::is_gz(bytes) {
            log::debug!("extracting AppImage update archive");
            appimage_archive::extract_appimage_from_archive(bytes, MAX_UPDATE_PACKAGE_BYTES)?
        } else {
            bytes.to_vec()
        };
        #[cfg(not(feature = "zip"))]
        let payload = bytes.to_vec();

        // Keep the recovery copy beside the installed image when possible so
        // it survives ordinary `/tmp` cleanup and remains on the install
        // filesystem for an atomic replacement.
        let mut temporary_roots = Vec::new();
        if let Some(parent) = self.extract_path.parent() {
            temporary_roots.push(parent.to_path_buf());
        }
        if let Some(cache_directory) = dirs::cache_dir() {
            temporary_roots.push(cache_directory);
        }
        temporary_roots.push(std::env::temp_dir());
        let backup =
            appimage_install::install_appimage_at(&self.extract_path, &payload, &temporary_roots)?;
        log::info!(
            "installed validated AppImage; previous image is recoverable at {}",
            backup.display()
        );
        Ok(())
    }

    fn install_deb(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .deb package
        if !infer::archive::is_deb(bytes) {
            log::warn!("update is not a valid deb package");
            return Err(Error::InvalidUpdaterFormat);
        }

        self.try_tmp_locations(bytes, "dpkg", &["-i"], "deb")
    }

    fn install_rpm(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .rpm package
        if !infer::archive::is_rpm(bytes) {
            return Err(Error::InvalidUpdaterFormat);
        }
        // semver already decided this is newer, but RPM orders prereleases
        // after their release (5.0.0-beta.1 > 5.0.0), so beta -> stable would
        // be refused as a downgrade without --oldpackage.
        self.try_tmp_locations(bytes, "rpm", &["-U", "--oldpackage"], "rpm")
    }

    fn try_tmp_locations(
        &self,
        bytes: &[u8],
        install_cmd: &str,
        install_args: &[&str],
        package_extension: &str,
    ) -> Result<()> {
        // Try different temp directories
        let tmp_dir_locations = vec![
            Box::new(|| Some(std::env::temp_dir())) as Box<dyn FnOnce() -> Option<PathBuf>>,
            Box::new(dirs::cache_dir),
            Box::new(|| Some(self.extract_path.parent().unwrap().to_path_buf())),
        ];

        // Try writing to multiple temp locations until one succeeds
        for tmp_dir_location in tmp_dir_locations {
            if let Some(path) = tmp_dir_location() {
                let prefix = format!("tauri_{package_extension}_update");
                if let Ok(tmp_dir) = tempfile::Builder::new().prefix(&prefix).tempdir_in(path) {
                    let pkg_path = tmp_dir.path().join(format!("package.{package_extension}"));

                    // Try writing the .deb / .rpm file
                    if std::fs::write(&pkg_path, bytes).is_ok() {
                        // If write succeeds, proceed with installation
                        return self.try_install_with_privileges(
                            &pkg_path,
                            install_cmd,
                            install_args,
                        );
                    }
                    // If write fails, continue to next temp location
                }
            }
        }

        // If we get here, all temp locations failed
        Err(Error::TempDirNotFound)
    }

    fn try_install_with_privileges(
        &self,
        pkg_path: &Path,
        install_cmd: &str,
        install_args: &[&str],
    ) -> Result<()> {
        let installer = crate::install_safety::resolve_trusted_system_helper(install_cmd)
            .map_err(|_| Error::PackageInstallFailed)?;
        let pkexec = crate::install_safety::resolve_trusted_system_helper("pkexec").ok();
        let sudo = crate::install_safety::resolve_trusted_system_helper("sudo").ok();

        // 1. First try using pkexec (graphical sudo prompt)
        if let Some(pkexec) = pkexec.as_ref() {
            let mut command = linux_privileged_command(pkexec);
            command.arg(&installer).args(install_args).arg(pkg_path);
            if let Ok(status) =
                linux_privileged_wait_status(command, std::time::Duration::from_secs(600))
            {
                if status.success() {
                    log::debug!("installed {pkg_path:?} with pkexec");
                    return Ok(());
                }
            }
        }

        // 2. Try zenity or kdialog for a graphical sudo experience
        if let Some(sudo) = sudo.as_ref() {
            if let Ok(password) = self.get_password_graphically() {
                if self.install_with_sudo(sudo, &installer, pkg_path, &password, install_args)? {
                    log::debug!("installed {pkg_path:?} with GUI sudo");
                    return Ok(());
                }
            }

            // 3. Final fallback: terminal sudo
            let mut command = linux_privileged_command(sudo);
            command.arg(&installer).args(install_args).arg(pkg_path);
            let status =
                linux_privileged_wait_status(command, std::time::Duration::from_secs(600))?;

            if status.success() {
                log::debug!("installed {pkg_path:?} with sudo");
                return Ok(());
            }
        }

        Err(Error::PackageInstallFailed)
    }

    fn get_password_graphically(&self) -> Result<String> {
        if let Ok(zenity) = crate::install_safety::resolve_trusted_system_helper("zenity") {
            let zenity_result = linux_privileged_command(&zenity)
                .args([
                    "--password",
                    "--title=Authentication Required",
                    "--text=Enter your password to install the update:",
                ])
                .output();

            if let Ok(output) = zenity_result {
                if output.status.success() {
                    return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
                }
            }
        }

        if let Ok(kdialog) = crate::install_safety::resolve_trusted_system_helper("kdialog") {
            let kdialog_result = linux_privileged_command(&kdialog)
                .args(["--password", "Enter your password to install the update:"])
                .output();

            if let Ok(output) = kdialog_result {
                if output.status.success() {
                    return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
                }
            }
        }

        Err(Error::AuthenticationFailed)
    }

    fn install_with_sudo(
        &self,
        sudo: &Path,
        installer: &Path,
        pkg_path: &Path,
        password: &str,
        install_args: &[&str],
    ) -> Result<bool> {
        use std::io::Write;
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        use std::time::Duration;

        let mut command = linux_privileged_command(sudo);
        command
            .arg("-S") // read password from stdin
            .arg(installer)
            .args(install_args)
            .arg(pkg_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Isolate the sudo/dpkg group so a timeout can kill the whole tree.
        command.process_group(0);

        let mut child = command.spawn()?;
        let pid = child.id();

        if let Some(mut stdin) = child.stdin.take() {
            writeln!(stdin, "{password}")?;
        }

        let output = wait_child_output_timeout(child, pid, Duration::from_secs(600))?;
        Ok(output.status.success())
    }
}

#[cfg(target_os = "linux")]
fn linux_privileged_wait_status(
    mut command: std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::ExitStatus> {
    use std::os::unix::process::CommandExt;
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.process_group(0);
    let child = command.spawn()?;
    let pid = child.id();
    let output = wait_child_output_timeout(child, pid, timeout)?;
    Ok(output.status)
}

#[cfg(target_os = "linux")]
fn linux_privileged_command(program: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    command.env_clear();
    command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    command.env("LC_ALL", "C");
    command.env("LANG", "C");
    for key in crate::install_safety::LINUX_PRIVILEGED_ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
}

#[cfg(target_os = "linux")]
fn wait_child_output_timeout(
    child: std::process::Child,
    pid: u32,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let finished = Arc::new(AtomicBool::new(false));
    let finished_for_killer = finished.clone();
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if finished_for_killer.load(Ordering::SeqCst) {
            return;
        }
        let pgid = format!("-{pid}");
        let _ = std::process::Command::new("/bin/kill")
            .args(["-TERM", "--", &pgid])
            .status();
        std::thread::sleep(std::time::Duration::from_secs(2));
        if finished_for_killer.load(Ordering::SeqCst) {
            return;
        }
        let _ = std::process::Command::new("/bin/kill")
            .args(["-KILL", "--", &pgid])
            .status();
    });

    let output = child.wait_with_output();
    finished.store(true, Ordering::SeqCst);
    output
}

/// MacOS
#[cfg(target_os = "macos")]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.app.tar.gz       # GZ generated by tauri-bundler
    /// │   └──[AppName].app                         # Main application
    /// │      └── Contents                          # Application contents...
    /// │          └── ...
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        crate::install_safety::with_macos_update_install_lock(|| self.install_inner_locked(bytes))
    }

    fn install_inner_locked(&self, bytes: &[u8]) -> Result<()> {
        use crate::install_safety::{
            is_cross_device, macos_app_bundle_complete, macos_app_bundle_identity,
            macos_update_backup_path, move_dir_replacing, MacosBundleIdentity,
            MACOS_PRIVILEGED_INSTALL_SCRIPT,
        };

        let app_parent = self
            .extract_path
            .parent()
            .ok_or(Error::FailedToDetermineExtractPath)?;
        let backup_path = macos_update_backup_path(&self.extract_path)
            .ok_or(Error::FailedToDetermineExtractPath)?;

        let expected_identity = MacosBundleIdentity {
            bundle_identifier: self.bundle_identifier.clone(),
            executable: self.executable_name.clone().ok_or_else(|| {
                Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "could not determine the installed app executable name",
                ))
            })?,
        };
        if !macos_bundle_matches(&self.extract_path, &expected_identity)
            && !macos_bundle_matches(&backup_path, &expected_identity)
        {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "neither the installed app nor its recovery backup matches the configured app identity",
            )));
        }

        let tmp_extract_dir = match tempfile::Builder::new()
            .prefix(".rosi-updated-app-")
            .tempdir_in(app_parent)
        {
            Ok(dir) => dir,
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                // `/Applications` is not user-writable. Extract in a user temp
                // dir; the privileged swap copies onto the app volume. Restore
                // must never nest `mv` into a partial `$SRC`.
                tempfile::Builder::new()
                    .prefix("tauri_updated_app")
                    .tempdir()?
            }
            Err(err) => return Err(err.into()),
        };

        extract_macos_app_archive(bytes, tmp_extract_dir.path())?;
        let staged_identity = macos_app_bundle_identity(tmp_extract_dir.path());
        if !macos_app_bundle_complete(tmp_extract_dir.path())
            || staged_identity.as_ref() != Some(&expected_identity)
        {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "staged updater bundle is incomplete or has a different app identity",
            )));
        }

        // Recovery can mutate a protected install tree. Delay it until the
        // downloaded bundle has passed identity and completeness validation,
        // then route only permission failures through the existing admin path.
        let recovery =
            recover_macos_live_bundle(&self.extract_path, &backup_path, &expected_identity)?;

        let unprivileged = if matches!(recovery, MacosRecoveryDisposition::RequiresPrivilegedSwap) {
            // A validated recovery entry can live in a protected install
            // directory. Keep it untouched until the staged bundle is fully
            // validated above, then let the privileged script perform the
            // recovery and replacement as one checked transition.
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "validated app recovery requires a privileged bundle transition",
            ))
        } else {
            (|| -> std::io::Result<()> {
                std::fs::rename(&self.extract_path, &backup_path)?;
                match move_dir_replacing(tmp_extract_dir.path(), &self.extract_path) {
                    Ok(()) => {
                        if !macos_bundle_matches(&self.extract_path, &expected_identity) {
                            restore_macos_live_bundle(
                                &self.extract_path,
                                &backup_path,
                                &expected_identity,
                            )?;
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "installed app bundle failed identity validation",
                            ));
                        }
                        // The backup was validated before the swap and remains a
                        // complete recovery point until the new live bundle passes
                        // the same identity check.
                        if let Err(error) =
                            remove_validated_macos_backup(&backup_path, &expected_identity)
                        {
                            // The new live bundle is already complete. Keep
                            // installation successful and leave the validated
                            // rollback entry for the next recovery pass.
                            log::warn!("could not remove validated updater backup: {error}");
                        }
                        Ok(())
                    }
                    Err(err) => {
                        restore_macos_live_bundle(
                            &self.extract_path,
                            &backup_path,
                            &expected_identity,
                        )?;
                        Err(err)
                    }
                }
            })()
        };

        match unprivileged {
            Ok(()) => {
                let _ = tmp_extract_dir.keep();
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::PermissionDenied || is_cross_device(&err) =>
            {
                log::debug!("app installation needs admin privileges");
                let src = self.extract_path.to_string_lossy().into_owned();
                let new = tmp_extract_dir.path().to_string_lossy().into_owned();
                let backup = backup_path.to_string_lossy().into_owned();
                let bundle_identifier = expected_identity.bundle_identifier.clone();
                let executable = expected_identity.executable.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                let res = (self.run_on_main_thread)(Box::new(move || {
                    let mut script = osakit::Script::new_from_source(
                        osakit::Language::AppleScript,
                        MACOS_PRIVILEGED_INSTALL_SCRIPT,
                    );
                    // compile() and execute_function() use different error
                    // types. Stringify both so a compile failure cannot panic
                    // or fail to type-check against the execute Result.
                    let r = script
                        .compile()
                        .map_err(|error| error.to_string())
                        .and_then(|()| {
                            script
                                .execute_function(
                                    "installUpdate",
                                    [
                                        osakit::Value::String(src),
                                        osakit::Value::String(new),
                                        osakit::Value::String(backup),
                                        osakit::Value::String(bundle_identifier),
                                        osakit::Value::String(executable),
                                    ],
                                )
                                .map_err(|error| error.to_string())
                        });
                    // The main-thread callback can be torn down during app
                    // shutdown. Sending best-effort keeps that teardown from
                    // turning an update failure into a process panic.
                    let _ = tx.send(r);
                }));
                if let Err(error) = res {
                    return Err(Error::Io(std::io::Error::other(format!(
                        "Failed to schedule the privileged macOS update: {error}"
                    ))));
                }
                let result = rx.recv().map_err(|_| {
                    Error::Io(std::io::Error::other(
                        "Privileged macOS update callback did not complete",
                    ))
                })?;

                if result.is_err() || !macos_bundle_matches(&self.extract_path, &expected_identity)
                {
                    return Err(Error::Io(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "Failed to install a complete app bundle with the expected identity",
                    )));
                }
                if let Err(error) = remove_macos_bundle_entry(&backup_path) {
                    log::warn!("could not remove validated updater backup: {error}");
                }
                let _ = tmp_extract_dir.keep();
            }
            Err(err) => return Err(err.into()),
        }

        let _ = std::process::Command::new("touch")
            .arg(&self.extract_path)
            .status();

        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn macos_bundle_matches(
    path: &Path,
    expected: &crate::install_safety::MacosBundleIdentity,
) -> bool {
    crate::install_safety::macos_app_bundle_complete(path)
        && crate::install_safety::macos_app_bundle_identity(path).as_ref() == Some(expected)
}

#[cfg(target_os = "macos")]
fn remove_macos_bundle_entry(path: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    }
}

#[cfg(target_os = "macos")]
fn remove_validated_macos_backup(
    backup: &Path,
    expected: &crate::install_safety::MacosBundleIdentity,
) -> std::io::Result<()> {
    if !macos_bundle_matches(backup, expected) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "refusing to retire an incomplete or identity-mismatched updater backup",
        ));
    }
    let parent = backup.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "updater backup has no parent directory",
        )
    })?;
    let retired_dir = tempfile::Builder::new()
        .prefix(".rosi-update-retired-backup-")
        .tempdir_in(parent)?;
    let retired_path = retired_dir.path().join("backup");

    // Move the complete backup atomically before recursive cleanup. A denied
    // rename leaves the recovery entry at its canonical path; a partial
    // recursive deletion cannot damage the live bundle or future recovery.
    std::fs::rename(backup, &retired_path)?;
    if !macos_bundle_matches(&retired_path, expected) {
        let restore = std::fs::rename(&retired_path, backup);
        if let Err(error) = restore {
            let retired_dir_path = retired_dir.keep();
            log::warn!(
                "could not restore updater backup from {}: {error}",
                retired_dir_path.display()
            );
            return Err(error);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "updater backup identity changed during retirement",
        ));
    }

    if let Err(error) = remove_macos_bundle_entry(&retired_path) {
        if macos_bundle_matches(&retired_path, expected) {
            // No partial deletion occurred. Put the validated recovery entry
            // back so PermissionDenied can be handled by the admin installer.
            if let Err(restore_error) = std::fs::rename(&retired_path, backup) {
                let retired_dir_path = retired_dir.keep();
                log::warn!(
                    "could not restore updater backup from {}: {restore_error}",
                    retired_dir_path.display()
                );
                return Err(restore_error);
            }
            return Err(error);
        }

        // The live bundle is still complete and will become the canonical
        // backup before it is replaced. Preserve any partly retired data for
        // diagnosis instead of letting TempDir drop retry recursive deletion.
        let retired_dir_path = retired_dir.keep();
        log::warn!(
            "updater backup cleanup was incomplete at {}: {error}",
            retired_dir_path.display()
        );
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            return Ok(());
        }
        return Err(error);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn restore_macos_live_bundle(
    live: &Path,
    backup: &Path,
    expected: &crate::install_safety::MacosBundleIdentity,
) -> std::io::Result<()> {
    if !macos_bundle_matches(backup, expected) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "refusing to restore an incomplete or identity-mismatched updater backup",
        ));
    }
    remove_macos_bundle_entry(live)?;
    std::fs::rename(backup, live)?;
    if !macos_bundle_matches(live, expected) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "restored updater backup failed identity validation",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacosRecoveryDisposition {
    ReadyForUnprivilegedSwap,
    RequiresPrivilegedSwap,
}

#[cfg(target_os = "macos")]
fn recover_macos_live_bundle(
    live: &Path,
    backup: &Path,
    expected: &crate::install_safety::MacosBundleIdentity,
) -> Result<MacosRecoveryDisposition> {
    let live_complete = macos_bundle_matches(live, expected);
    let backup_complete = macos_bundle_matches(backup, expected);
    let backup_exists = match std::fs::symlink_metadata(backup) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if live_complete {
        if backup_exists {
            if !backup_complete {
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "refusing to remove an incomplete or identity-mismatched updater backup",
                )));
            }
            return match remove_validated_macos_backup(backup, expected) {
                Ok(()) => Ok(MacosRecoveryDisposition::ReadyForUnprivilegedSwap),
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    Ok(MacosRecoveryDisposition::RequiresPrivilegedSwap)
                }
                Err(error) => Err(error.into()),
            };
        }
        return Ok(MacosRecoveryDisposition::ReadyForUnprivilegedSwap);
    }
    if backup_complete {
        return match restore_macos_live_bundle(live, backup, expected) {
            Ok(()) => Ok(MacosRecoveryDisposition::ReadyForUnprivilegedSwap),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                Ok(MacosRecoveryDisposition::RequiresPrivilegedSwap)
            }
            Err(error) => Err(error.into()),
        };
    }
    Err(Error::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "installed app is incomplete and no complete matching recovery backup exists",
    )))
}

#[cfg(target_os = "macos")]
fn extract_macos_app_archive(bytes: &[u8], dest_root: &Path) -> Result<()> {
    use crate::install_safety::{
        confined_symlink_target, confined_tar_member_relative, create_confined_parent_dirs,
        path_is_inside,
    };
    use flate2::read::GzDecoder;
    use tar::EntryType;

    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let entry_path = entry.path()?.into_owned();
        let relative = confined_tar_member_relative(&entry_path).map_err(|_| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "updater archive member path is not confined",
            ))
        })?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let dest = dest_root.join(&relative);
        if !path_is_inside(dest_root, &dest) {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "updater archive member path is not confined",
            )));
        }
        let kind = entry.header().entry_type();
        if kind == EntryType::Link {
            return Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "hard links are not allowed in updater archives",
            )));
        }
        if kind.is_symlink() {
            let target = entry.link_name()?.ok_or_else(|| {
                Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "symlink is missing a target",
                ))
            })?;
            let parent = dest.parent().unwrap_or(dest_root);
            if !confined_symlink_target(dest_root, parent, target.as_ref()) {
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "symlink target escapes updater extract root",
                )));
            }
            create_confined_parent_dirs(dest_root, &dest)?;
            std::os::unix::fs::symlink(target.as_ref(), &dest)?;
            continue;
        }
        if kind.is_dir() {
            create_confined_parent_dirs(dest_root, &dest)?;
            match std::fs::symlink_metadata(&dest) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&dest)?;
                }
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(Error::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "updater archive directory collides with a non-directory",
                    )));
                }
                Err(err) => return Err(err.into()),
            }
            continue;
        }
        if kind.is_file() || matches!(kind, EntryType::GNUSparse) {
            create_confined_parent_dirs(dest_root, &dest)?;
            entry.unpack(&dest)?;
            continue;
        }
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("unsupported updater archive member type {kind:?}"),
        )));
    }
    Ok(())
}

/// Gets the base target string used by the updater. If bundle type is available it
/// will be added to this string when selecting the download URL and signature.
/// `tauri::utils::platform::bundle_type` method is used to obtain current bundle type.
pub fn target() -> Option<String> {
    if let (Some(target), Some(arch)) = (updater_os(), updater_arch()) {
        Some(format!("{target}-{arch}"))
    } else {
        None
    }
}

fn updater_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // TODO shouldn't this be macos instead?
        Some("darwin")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else {
        None
    }
}

fn updater_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86") {
        Some("i686")
    } else if cfg!(target_arch = "x86_64") {
        Some("x86_64")
    } else if cfg!(target_arch = "arm") {
        Some("armv7")
    } else if cfg!(target_arch = "aarch64") {
        Some("aarch64")
    } else if cfg!(target_arch = "riscv64") {
        Some("riscv64")
    } else {
        None
    }
}

pub fn extract_path_from_executable(executable_path: &Path) -> Result<PathBuf> {
    // Return the path of the current executable by default
    // Example C:\Program Files\My App\
    let extract_path = executable_path
        .parent()
        .map(PathBuf::from)
        .ok_or(Error::FailedToDetermineExtractPath)?;

    // MacOS example binary is in /Applications/TestApp.app/Contents/MacOS/myApp
    // We need to get /Applications/<app>.app
    // TODO(lemarier): Need a better way here
    // Maybe we could search for <*.app> to get the right path
    #[cfg(target_os = "macos")]
    if extract_path
        .display()
        .to_string()
        .contains("Contents/MacOS")
    {
        return extract_path
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath)?
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath);
    }

    Ok(extract_path)
}

impl<'de> Deserialize<'de> for RemoteRelease {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct InnerRemoteRelease {
            #[serde(alias = "name", deserialize_with = "parse_version")]
            version: Version,
            notes: Option<String>,
            pub_date: Option<String>,
            platforms: Option<HashMap<String, ReleaseManifestPlatform>>,
            // dynamic platform response
            url: Option<Url>,
            signature: Option<String>,
        }

        let release = InnerRemoteRelease::deserialize(deserializer)?;

        let pub_date = if let Some(date) = release.pub_date {
            Some(
                OffsetDateTime::parse(&date, &time::format_description::well_known::Rfc3339)
                    .map_err(|e| DeError::custom(format!("invalid value for `pub_date`: {e}")))?,
            )
        } else {
            None
        };

        Ok(RemoteRelease {
            version: release.version,
            notes: release.notes,
            pub_date,
            data: if let Some(platforms) = release.platforms {
                RemoteReleaseInner::Static { platforms }
            } else {
                RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                    url: release.url.ok_or_else(|| {
                        DeError::custom("the `url` field was not set on the updater response")
                    })?,
                    signature: release.signature.ok_or_else(|| {
                        DeError::custom("the `signature` field was not set on the updater response")
                    })?,
                })
            },
        })
    }
}

fn installer_for_bundle_type(bundle: Option<BundleType>) -> Option<Installer> {
    match bundle? {
        BundleType::Deb => Some(Installer::Deb),
        BundleType::Rpm => Some(Installer::Rpm),
        BundleType::AppImage => Some(Installer::AppImage),
        BundleType::Msi => Some(Installer::Msi),
        BundleType::Nsis => Some(Installer::Nsis),
        BundleType::App => Some(Installer::App), // App is also returned for Dmg type
        _ => None,
    }
}

fn parse_version<'de, D>(deserializer: D) -> std::result::Result<Version, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let str = String::deserialize(deserializer)?;

    Version::from_str(str.trim_start_matches('v')).map_err(serde::de::Error::custom)
}

// Validate signature
fn verify_signature(data: &[u8], release_signature: &str, pub_key: &str) -> Result<bool> {
    // we need to convert the pub key
    let pub_key_decoded = base64_to_string(pub_key)?;
    let public_key = PublicKey::decode(&pub_key_decoded)?;
    let signature_base64_decoded = base64_to_string(release_signature)?;
    let signature = Signature::decode(&signature_base64_decoded)?;

    // Validate signature or bail out
    public_key.verify(data, &signature, true)?;
    Ok(true)
}

fn base64_to_string(base64_string: &str) -> Result<String> {
    let decoded_string = &base64::engine::general_purpose::STANDARD.decode(base64_string)?;
    let result = std::str::from_utf8(decoded_string)
        .map_err(|_| Error::SignatureUtf8(base64_string.into()))?
        .to_string();
    Ok(result)
}

#[cfg(windows)]
fn encode_wide(string: impl AsRef<OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    string
        .as_ref()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
trait PathExt {
    fn wrap_in_quotes(&self) -> Self;
}

#[cfg(windows)]
impl PathExt for PathBuf {
    fn wrap_in_quotes(&self) -> Self {
        let mut msi_path = OsString::from("\"");
        msi_path.push(self.as_os_str());
        msi_path.push("\"");
        PathBuf::from(msi_path)
    }
}

// adapted from https://github.com/rust-lang/rust/blob/1c047506f94cd2d05228eb992b0a6bbed1942349/library/std/src/sys/args/windows.rs#L174
#[cfg(windows)]
fn escape_nsis_current_exe_arg(arg: &&OsStr) -> String {
    let arg = arg.to_string_lossy();
    let mut cmd: Vec<char> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg.chars().any(|c| c == ' ' || c == '\t' || c == '/') || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"');
    }
    let mut backslashes: usize = 0;
    for x in arg.chars() {
        if escape {
            if x == '\\' {
                backslashes += 1;
            } else {
                if x == '"' {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\'));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\'));
        cmd.push('"');
    }
    cmd.into_iter().collect()
}

#[cfg(windows)]
fn escape_msi_property_arg(arg: impl AsRef<OsStr>) -> String {
    let mut arg = arg.as_ref().to_string_lossy().to_string();

    // Otherwise this argument will get lost in ShellExecute
    if arg.is_empty() {
        return "\"\"\"\"".to_string();
    } else if !arg.contains(' ') && !arg.contains('"') {
        return arg;
    }

    if arg.contains('"') {
        arg = arg.replace('"', r#""""""#);
    }

    if arg.starts_with('-') {
        if let Some((a1, a2)) = arg.split_once('=') {
            format!("{a1}=\"\"{a2}\"\"")
        } else {
            format!("\"\"{arg}\"\"")
        }
    } else {
        format!("\"\"{arg}\"\"")
    }
}

#[cfg(test)]
mod tests {

    use super::{finish_windows_installer_launch, OnBeforeExit, Update};
    use crate::{Config, Error};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn round2_update_with_hook(before_exit: OnBeforeExit, cleanup: Arc<AtomicUsize>) -> Update {
        Update {
            run_on_main_thread: Arc::new(Box::new(|_| Ok(()))),
            config: Config::default(),
            on_before_exit: Some(before_exit),
            on_windows_installer_launched: Some(Arc::new(move || {
                cleanup.fetch_add(1, Ordering::SeqCst);
            })),
            body: None,
            current_version: "1.0.0".to_string(),
            version: "1.0.1".to_string(),
            date: None,
            target: "test".to_string(),
            download_url: url::Url::parse("https://example.invalid/update").unwrap(),
            signature: String::new(),
            raw_json: serde_json::Value::Null,
            timeout: None,
            proxy: None,
            no_proxy: false,
            headers: Default::default(),
            extract_path: std::path::PathBuf::from("/unused/round2-app"),
            app_name: "ROSI".to_string(),
            bundle_identifier: "run.rosie.rosi".to_string(),
            executable_name: Some("rosi".to_string()),
            installer_args: Vec::new(),
            current_exe_args: Vec::new(),
            configure_client: None,
        }
    }

    #[test]
    fn round2_actual_update_install_hook_failure_keeps_update_and_skips_cleanup() {
        let hook_calls = Arc::new(AtomicUsize::new(0));
        let hook_calls_in = Arc::clone(&hook_calls);
        let cleanup_calls = Arc::new(AtomicUsize::new(0));
        let update = round2_update_with_hook(
            Arc::new(move || {
                hook_calls_in.fetch_add(1, Ordering::SeqCst);
                Err("round2 forced durable-state flush failure".to_string())
            }),
            Arc::clone(&cleanup_calls),
        );

        let error = update
            .install(b"invalid installer bytes")
            .expect_err("a failed pre-install hook must reject the actual install call");
        assert!(matches!(
            error,
            Error::BeforeExit(message) if message == "round2 forced durable-state flush failure"
        ));
        assert_eq!(hook_calls.load(Ordering::SeqCst), 1);
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn round2_windows_cleanup_runs_only_after_a_successful_installer_launch() {
        let events = std::cell::RefCell::new(Vec::new());
        let failure = finish_windows_installer_launch(
            32,
            || events.borrow_mut().push("cleanup"),
            || events.borrow_mut().push("exit"),
        );
        assert!(failure.is_err());
        assert!(
            events.borrow().is_empty(),
            "failed launch must preserve Tauri resources"
        );

        finish_windows_installer_launch(
            33,
            || events.borrow_mut().push("cleanup"),
            || events.borrow_mut().push("exit"),
        )
        .expect("successful launch must finish cleanup and exit sequence");
        assert_eq!(&*events.borrow(), &["cleanup", "exit"]);
    }

    #[test]
    fn round2_download_cap_rejects_oversize_chunks_without_content_length() {
        let mut received = Vec::new();
        super::append_download_chunk(&mut received, b"123", None, 4)
            .expect("under-limit chunk should be accepted without a length header");
        let error = super::append_download_chunk(&mut received, b"45", None, 4)
            .expect_err("actual streamed size must be capped without Content-Length");
        assert!(error.to_string().contains("package exceeds"));
        assert_eq!(received, b"123", "over-limit bytes must not be buffered");
    }

    #[test]
    fn round2_download_cap_rejects_declared_oversize_and_actual_oversize() {
        let mut received = Vec::new();
        assert!(super::validate_download_content_length(Some(5), 4).is_err());
        assert!(super::append_download_chunk(&mut received, b"12345", Some(1), 4).is_err());
        assert!(received.is_empty(), "rejected bytes must not be buffered");
    }

    #[test]
    #[cfg(windows)]
    fn it_wraps_correctly() {
        use super::PathExt;
        use std::path::PathBuf;

        assert_eq!(
            PathBuf::from("C:\\Users\\Some User\\AppData\\tauri-example.exe").wrap_in_quotes(),
            PathBuf::from("\"C:\\Users\\Some User\\AppData\\tauri-example.exe\"")
        )
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_msi() {
        use crate::updater::escape_msi_property_arg;

        // Explanation for quotes:
        // The output of escape_msi_property_args() will be used in `LAUNCHAPPARGS=\"{HERE}\"`. This is the first quote level.
        // To escape a quotation mark we use a second quotation mark, so "" is interpreted as " later.
        // This means that the escaped strings can't ever have a single quotation mark!
        // Now there are 3 major things to look out for to not break the msiexec call:
        //   1) Wrap spaces in quotation marks, otherwise it will be interpreted as the end of the msiexec argument.
        //   2) Escape escaping quotation marks, otherwise they will either end the msiexec argument or be ignored.
        //   3) Escape emtpy args in quotation marks, otherwise the argument will get lost.
        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"\"some space\"\"",
            "\"\"--arg value\"\"",
            "--arg=\"\"unwrapped space\"\"",
            r#"--arg=""""""wrapped"""""""#,
            r#"--arg=""""""wrapped space"""""""#,
            r#"--arg=""midword""""wrapped space"""""""#,
            "\"\"\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_msi_property_arg(orig), escaped);
        }
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_nsis() {
        use crate::updater::escape_nsis_current_exe_arg;
        use std::ffi::OsStr;

        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        // Note: These may not be the results we actually want (monitor this!).
        // We only make sure the implementation doesn't unintentionally change.
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"some space\"",
            "\"--arg value\"",
            "\"--arg=unwrapped space\"",
            "--arg=\\\"wrapped\\\"",
            "\"--arg=\\\"wrapped space\\\"\"",
            "\"--arg=midword\\\"wrapped space\\\"\"",
            "\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_nsis_current_exe_arg(&OsStr::new(orig)), escaped);
        }
    }

    #[test]
    fn macos_admin_install_script_quotes_paths_via_handler_args() {
        use crate::install_safety::MACOS_PRIVILEGED_INSTALL_SCRIPT;
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("quoted form of"),
            "privileged install must quote paths with AppleScript quoted form of"
        );
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("backupPath"),
            "privileged install must restore from a sibling backup"
        );
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("CFBundleIdentifier")
                && MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("CFBundleExecutable"),
            "privileged install must validate bundle identity and executable"
        );
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("Contents/Resources")
                && MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("Contents/MacOS"),
            "privileged install must validate required bundle resources"
        );
        assert!(
            MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/bin/test -d \\\"$SRC/Contents\\\""),
            "privileged install must verify Contents before deleting the backup"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("rm -rf \" & quoted form of srcPath"),
            "privileged install must never rm -rf the live bundle via AppleScript concatenation"
        );
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("Zinnia.app")
                && !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains("/Applications"),
            "script template must not embed filesystem paths"
        );
        let malicious = "/Applications/Don't '; touch /tmp/pwned; '.app";
        assert!(
            !MACOS_PRIVILEGED_INSTALL_SCRIPT.contains(malicious),
            "malicious path must stay outside the constant script body"
        );
    }
}
