//! Explicit local data location selection. Resolution never creates directories
//! or silently switches storage locations after a configuration error.

use serde::Deserialize;
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const LOCAL_CONFIGURATION: &str = "runbook.local.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalConfiguration {
    data_directory: PathBuf,
}

/// Resolve environment override, explicit local configuration, then the system
/// default. Invalid explicit choices are errors rather than fallback requests.
pub fn resolve(
    executable: &Path,
    environment_override: Option<OsString>,
    default_directory: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(value) = environment_override {
        return require_absolute(PathBuf::from(value), "环境变量 RUNBOOK_DATA_DIR");
    }

    let executable_directory = executable
        .parent()
        .ok_or_else(|| format!("无法确定可执行文件所在目录：{}", executable.display()))?;
    let configuration_path = executable_directory.join(LOCAL_CONFIGURATION);
    match fs::symlink_metadata(&configuration_path) {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return require_absolute(default_directory()?, "系统默认数据目录");
        }
        Err(error) => {
            return Err(format!(
                "无法检查本地配置文件：{}。详细错误：{error}",
                configuration_path.display()
            ));
        }
        Ok(_) => {}
    }
    match fs::read_to_string(&configuration_path) {
        Ok(contents) => {
            let configuration: LocalConfiguration = serde_json::from_str(&contents).map_err(|error| {
                format!(
                    "本地配置文件格式错误：{}。请提供仅含 dataDirectory 的 JSON 对象。详细错误：{error}",
                    configuration_path.display()
                )
            })?;
            require_absolute(
                configuration.data_directory,
                &format!(
                    "本地配置文件 {} 的 dataDirectory",
                    configuration_path.display()
                ),
            )
        }
        Err(error) => Err(format!(
            "无法读取本地配置文件：{}。为避免切换到其他数据目录，启动已停止。详细错误：{error}",
            configuration_path.display()
        )),
    }
}

fn require_absolute(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err(format!("{source} 不能为空，必须指定绝对路径。"));
    }
    if !path.is_absolute() {
        return Err(format!(
            "{source} 必须是绝对路径，当前值：{}",
            path.display()
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_override_precedes_even_invalid_configuration() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(LOCAL_CONFIGURATION), "invalid JSON").unwrap();
        let expected = directory.path().join("environment-data");
        let actual = resolve(
            &directory.path().join("runbook-desktop.exe"),
            Some(expected.clone().into_os_string()),
            || panic!("The default path must not be requested"),
        )
        .unwrap();
        assert_eq!(actual, expected);
        assert!(!actual.exists(), "Resolution must not create a directory");
    }

    #[test]
    fn configuration_precedes_default_without_creating_directory() {
        let directory = tempfile::tempdir().unwrap();
        let expected = directory.path().join("configured-data");
        fs::write(
            directory.path().join(LOCAL_CONFIGURATION),
            serde_json::json!({ "dataDirectory": expected }).to_string(),
        )
        .unwrap();
        let actual = resolve(&directory.path().join("runbook-desktop.exe"), None, || {
            panic!("The default path must not be requested")
        })
        .unwrap();
        assert_eq!(actual, expected);
        assert!(!actual.exists(), "Resolution must not create a directory");
    }

    #[test]
    fn missing_configuration_uses_default() {
        let directory = tempfile::tempdir().unwrap();
        let expected = directory.path().join("system-default");
        let actual = resolve(&directory.path().join("runbook-desktop.exe"), None, || {
            Ok(expected.clone())
        })
        .unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn malformed_json_unknown_fields_and_nonabsolute_paths_are_errors() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("runbook-desktop.exe");
        let configuration_path = directory.path().join(LOCAL_CONFIGURATION);
        for contents in [
            "invalid JSON",
            r#"{"dataDirectory":"relative"}"#,
            r#"{"dataDirectory":""}"#,
            r#"{"dataDirectory":"relative","unknown":true}"#,
        ] {
            fs::write(&configuration_path, contents).unwrap();
            let error = resolve(&executable, None, || {
                panic!("An invalid configuration must not use the default")
            })
            .unwrap_err();
            assert!(error.contains(configuration_path.to_string_lossy().as_ref()));
        }
        for override_value in [OsString::new(), OsString::from("relative")] {
            assert!(resolve(&executable, Some(override_value), || {
                panic!("An invalid override must not use the default")
            })
            .is_err());
        }
        fs::remove_file(configuration_path).unwrap();
        assert!(resolve(&executable, None, || Ok(PathBuf::from("relative"))).is_err());
        assert!(resolve(&executable, None, || Ok(PathBuf::new())).is_err());
    }

    #[test]
    fn existing_configuration_read_errors_do_not_use_default() {
        let directory = tempfile::tempdir().unwrap();
        let configuration_path = directory.path().join(LOCAL_CONFIGURATION);
        fs::create_dir(&configuration_path).unwrap();
        let error = resolve(&directory.path().join("runbook-desktop.exe"), None, || {
            panic!("A configuration read error must not use the default")
        })
        .unwrap_err();
        assert!(error.contains("无法读取本地配置文件"));
        assert!(error.contains(configuration_path.to_string_lossy().as_ref()));
    }
}
