//! Diagnostics available before Tauri and WebView initialization.
//!
//! Callers must only record startup stages and technical errors, never document
//! text, commands, database contents, or other Runbook business data.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: OnceLock<Mutex<LogSink>> = OnceLock::new();
static INSTALLED: AtomicBool = AtomicBool::new(false);
static REPORTING_FAILURE: AtomicBool = AtomicBool::new(false);

struct LogSink {
    file: Option<File>,
    path: Option<PathBuf>,
}

impl LogSink {
    fn create(executable_directory: Option<&Path>, temporary_directory: &Path) -> Self {
        let fallback = temporary_directory.join("Runbook");
        let candidates = executable_directory
            .into_iter()
            .map(Path::to_path_buf)
            .chain(std::iter::once(fallback));

        for directory in candidates {
            if fs::create_dir_all(&directory).is_err() {
                continue;
            }
            let path = directory.join("runbook-startup.log");
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&path)
            {
                return Self {
                    file: Some(file),
                    path: Some(fs::canonicalize(&path).unwrap_or(path)),
                };
            }
        }

        Self {
            file: None,
            path: None,
        }
    }

    fn write(&mut self, message: &str) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.write_all(message.as_bytes())?;
            file.flush()
        } else {
            io::stderr().write_all(message.as_bytes())
        }
    }
}

fn log() -> &'static Mutex<LogSink> {
    LOG.get_or_init(|| {
        let executable = std::env::current_exe().ok();
        Mutex::new(LogSink::create(
            executable.as_deref().and_then(Path::parent),
            &std::env::temp_dir(),
        ))
    })
}

fn format_entry(message: &str, timestamp_millis: u128) -> String {
    let mut sanitized = String::new();
    for character in message.chars().take(4096) {
        match character {
            '\n' => sanitized.push_str("\\n"),
            '\r' => sanitized.push_str("\\r"),
            '\t' => sanitized.push_str("\\t"),
            value if value.is_control() => sanitized.push('?'),
            value => sanitized.push(value),
        }
    }
    if message.chars().count() > 4096 {
        sanitized.push_str(" [truncated]");
    }
    format!("[unix_ms={timestamp_millis}] {sanitized}\n")
}

/// Establish a new startup log and a panic hook, without requiring a window.
pub fn install() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    record("Runbook startup; diagnostics exclude business data");
    record(&format!("pid={}", std::process::id()));
    record(&format!("exe={:?}", std::env::current_exe()));
    record(&format!("cwd={:?}", std::env::current_dir()));
    record(&format!(
        "LOCALAPPDATA={:?}",
        std::env::var_os("LOCALAPPDATA")
    ));
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown location".to_owned());
        // Panic payloads can contain document or command text. Persist only the
        // source location, while preserving normal stderr behavior for debugging.
        report_failure(&format!("程序发生内部错误。错误位置：{location}"));
        previous_hook(panic_info);
    }));
}

/// Persist one technical startup event. Logging itself never panics.
pub fn record(message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let entry = format_entry(message, timestamp);
    match log().try_lock() {
        Ok(mut sink) => {
            if sink.write(&entry).is_err() {
                let _ = io::stderr().write_all(entry.as_bytes());
            }
        }
        Err(_) => {
            let _ = io::stderr().write_all(entry.as_bytes());
        }
    }
}

/// Show a native failure dialog even when Tauri/WebView initialization failed.
pub fn report_failure(message: &str) {
    // Also protects the panic hook if allocation or another diagnostic fails.
    if REPORTING_FAILURE.swap(true, Ordering::SeqCst) {
        let _ = io::stderr().write_all(b"Runbook: recursive startup failure\n");
        return;
    }

    record(&format!("Startup failure: {message}"));
    let log_path = log()
        .try_lock()
        .ok()
        .and_then(|sink| sink.path.clone())
        .map(|path| path.display().to_string());
    let diagnostic_location = match log_path {
        Some(path) => format!("启动日志：{path}"),
        None => "启动日志无法写入磁盘；诊断已输出到标准错误。".to_owned(),
    };
    let dialog_message = format!(
        "Runbook 未能正常运行。\n\n{message}\n\n{diagnostic_location}\n\n请将此提示和启动日志提供给开发者。"
    );
    if std::env::var_os("RUNBOOK_NO_ERROR_DIALOG").as_deref() != Some(std::ffi::OsStr::new("1")) {
        show_error_dialog(&dialog_message);
    }
    REPORTING_FAILURE.store(false, Ordering::SeqCst);
}

#[cfg(windows)]
fn show_error_dialog(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            owner: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            message_type: u32,
        ) -> i32;
    }

    let text: Vec<u16> = message
        .replace('\0', "?")
        .encode_utf16()
        .chain([0])
        .collect();
    let caption: Vec<u16> = "Runbook 启动失败".encode_utf16().chain([0]).collect();
    // MB_OK | MB_ICONERROR | MB_SETFOREGROUND: no Tauri context or WebView needed.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            0x0000_0010 | 0x0001_0000,
        );
    }
}

#[cfg(not(windows))]
fn show_error_dialog(message: &str) {
    let _ = writeln!(io::stderr(), "{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_format_keeps_events_on_one_line() {
        assert_eq!(
            format_entry("启动\r\nready\t\0", 42),
            "[unix_ms=42] 启动\\r\\nready\\t?\n"
        );
        let long_entry = format_entry(&"a".repeat(4097), 42);
        assert!(long_entry.ends_with(" [truncated]\n"));
    }

    #[test]
    fn unavailable_primary_log_uses_temporary_directory() {
        let sandbox = tempfile::tempdir().unwrap();
        let executable_directory = sandbox.path().join("executable");
        fs::create_dir_all(executable_directory.join("runbook-startup.log")).unwrap();
        let temporary_directory = sandbox.path().join("temporary");
        let mut sink = LogSink::create(Some(&executable_directory), &temporary_directory);
        let expected = temporary_directory.join("Runbook/runbook-startup.log");
        assert_eq!(sink.path, Some(fs::canonicalize(&expected).unwrap()));
        sink.write(&format_entry("ready", 42)).unwrap();
        assert_eq!(
            fs::read_to_string(expected).unwrap(),
            "[unix_ms=42] ready\n"
        );
    }

    #[test]
    fn new_session_replaces_previous_log_and_both_blocked_paths_are_safe() {
        let sandbox = tempfile::tempdir().unwrap();
        let executable_directory = sandbox.path().join("executable");
        fs::create_dir_all(&executable_directory).unwrap();
        let path = executable_directory.join("runbook-startup.log");
        fs::write(&path, "previous session").unwrap();
        let temporary_directory = sandbox.path().join("temporary");
        let mut sink = LogSink::create(Some(&executable_directory), &temporary_directory);
        sink.write(&format_entry("new session", 43)).unwrap();
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "[unix_ms=43] new session\n"
        );
        drop(sink);

        let blocked_primary = sandbox.path().join("not-a-directory");
        fs::write(&blocked_primary, "occupied").unwrap();
        let blocked_temporary = sandbox.path().join("blocked-temporary");
        fs::write(&blocked_temporary, "occupied").unwrap();
        let unavailable = LogSink::create(Some(&blocked_primary), &blocked_temporary);
        assert!(unavailable.path.is_none());
        assert!(unavailable.file.is_none());
    }
}
