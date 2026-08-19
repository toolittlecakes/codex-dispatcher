#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

struct TrayMenu {
    status: MenuItem<tauri::Wry>,
    open: MenuItem<tauri::Wry>,
    copy_link: MenuItem<tauri::Wry>,
    restart: MenuItem<tauri::Wry>,
    login: MenuItem<tauri::Wry>,
}

#[derive(Default)]
struct AppState {
    serve_pid: Mutex<Option<u32>>,
    quitting: AtomicBool,
    login_running: AtomicBool,
}

fn dispatcher_home() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME is not set");
    PathBuf::from(home).join(".codex-dispatcher")
}

// serve writes runtime.json (pid + the URLs with the webview token) on start;
// this is the tray's whole read contract with it.
fn read_runtime_urls(expected_pid: u32) -> Option<(String, Option<String>)> {
    let raw = fs::read_to_string(dispatcher_home().join("runtime.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("pid").and_then(|p| p.as_u64()) != Some(expected_pid as u64) {
        return None;
    }
    let local = value.get("localUrl")?.as_str()?.to_string();
    let phone = value
        .get("phoneUrl")
        .and_then(|p| p.as_str())
        .map(str::to_string);
    Some((local, phone))
}

fn relay_configured() -> bool {
    let Ok(raw) = fs::read_to_string(dispatcher_home().join("config.json")) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .map(|config| config.get("relay").is_some())
        .unwrap_or(false)
}

// A .app inherits the bare launchd PATH, which is missing wherever `codex`
// actually lives; the user's login shell knows.
fn login_shell_path() -> String {
    Command::new("/bin/zsh")
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

fn log_line(line: &str) {
    use std::io::Write as _;
    let path = dispatcher_home().join("tray.log");
    let _ = fs::create_dir_all(dispatcher_home());
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn spawn_serve(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.serve_pid.lock().unwrap().is_some() {
        return;
    }

    let menu = app.state::<TrayMenu>();
    let _ = menu.status.set_text("Starting…");
    let _ = menu.open.set_enabled(false);
    let _ = menu.copy_link.set_enabled(false);
    let _ = menu.restart.set_enabled(false);

    let mut args = vec!["serve".to_string(), "--skip-updates".to_string()];
    if relay_configured() {
        args.push("--relay".to_string());
        args.push("--kill-existing".to_string());
    }

    let command = match app.shell().sidecar("codex-dispatcher") {
        Ok(command) => command
            .args(&args)
            .env("PATH", login_shell_path())
            .current_dir(std::env::var("HOME").expect("HOME is not set")),
        Err(error) => {
            let _ = menu.status.set_text(format!("Failed to start: {error}"));
            return;
        }
    };

    let (mut rx, child) = match command.spawn() {
        Ok(spawned) => spawned,
        Err(error) => {
            let _ = menu.status.set_text(format!("Failed to start: {error}"));
            let _ = menu.restart.set_enabled(true);
            return;
        }
    };

    let pid = child.pid();
    *state.serve_pid.lock().unwrap() = Some(pid);
    log_line(&format!("--- serve started, pid {pid}, args {args:?}"));

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end();
                    log_line(line);
                    if line.contains("Codex dispatcher listening") {
                        mark_running(&app, pid);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<AppState>();
                    *state.serve_pid.lock().unwrap() = None;
                    log_line(&format!("--- serve exited: {:?}", payload.code));
                    if state.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    let menu = app.state::<TrayMenu>();
                    let code = payload
                        .code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".to_string());
                    let _ = menu.status.set_text(format!("Stopped (exit {code})"));
                    let _ = menu.open.set_enabled(false);
                    let _ = menu.copy_link.set_enabled(false);
                    let _ = menu.restart.set_enabled(true);
                    let _ = app
                        .notification()
                        .builder()
                        .title("Codex Dispatcher stopped")
                        .body(format!("serve exited ({code}) — see ~/.codex-dispatcher/tray.log"))
                        .show();
                    break;
                }
                _ => {}
            }
        }
    });
}

fn mark_running(app: &AppHandle, pid: u32) {
    let menu = app.state::<TrayMenu>();
    // runtime.json lands right after the "listening" line; a few retries cover
    // the gap without a watcher.
    for _ in 0..50 {
        if let Some((_, phone)) = read_runtime_urls(pid) {
            let label = match &phone {
                Some(_) => "Running (relay)",
                None => "Running (local)",
            };
            let _ = menu.status.set_text(label);
            let _ = menu.open.set_enabled(true);
            let _ = menu.copy_link.set_enabled(true);
            let _ = menu.restart.set_enabled(true);
            let _ = menu
                .copy_link
                .set_text(if phone.is_some() { "Copy Phone Link" } else { "Copy Local Link" });
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = menu.status.set_text("Running, but runtime.json never appeared");
}

fn stop_serve(app: &AppHandle) {
    let state = app.state::<AppState>();
    let pid = state.serve_pid.lock().unwrap().take();
    if let Some(pid) = pid {
        // SIGTERM, not CommandChild::kill: the cli traps it and takes the
        // dispatcher and tunnel down with itself; SIGKILL would orphan them.
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    }
}

fn current_urls(app: &AppHandle) -> Option<(String, Option<String>)> {
    let state = app.state::<AppState>();
    let pid = (*state.serve_pid.lock().unwrap())?;
    read_runtime_urls(pid)
}

fn run_relay_login(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.login_running.swap(true, Ordering::SeqCst) {
        return;
    }

    let command = match app.shell().sidecar("codex-dispatcher") {
        Ok(command) => command.args(["login"]).env("PATH", login_shell_path()),
        Err(error) => {
            log_line(&format!("login sidecar failed: {error}"));
            state.login_running.store(false, Ordering::SeqCst);
            return;
        }
    };
    let (mut rx, _child) = match command.spawn() {
        Ok(spawned) => spawned,
        Err(error) => {
            log_line(&format!("login spawn failed: {error}"));
            state.login_running.store(false, Ordering::SeqCst);
            return;
        }
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    log_line(&format!("[login] {line}"));
                    if line.starts_with("https://") {
                        let _ = app.opener().open_url(line, None::<&str>);
                    }
                    if let Some(code) = line.strip_prefix("Enter code: ") {
                        let _ = app.clipboard().write_text(code.to_string());
                        let _ = app
                            .notification()
                            .builder()
                            .title("GitHub login code copied")
                            .body(format!("{code} — paste it on the GitHub page"))
                            .show();
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let state = app.state::<AppState>();
                    state.login_running.store(false, Ordering::SeqCst);
                    if payload.code == Some(0) {
                        let _ = app
                            .notification()
                            .builder()
                            .title("Relay login complete")
                            .body("Restarting the dispatcher through the relay")
                            .show();
                        let menu = app.state::<TrayMenu>();
                        let _ = menu.login.set_enabled(false);
                        // Picks up --relay now that config.json has the login;
                        // spawn_serve re-runs once the old serve reports exit.
                        stop_serve(&app);
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            for _ in 0..50 {
                                if app.state::<AppState>().serve_pid.lock().unwrap().is_none() {
                                    break;
                                }
                                tokio_sleep(100).await;
                            }
                            spawn_serve(&app);
                        });
                    } else {
                        let _ = app
                            .notification()
                            .builder()
                            .title("Relay login failed")
                            .body("See ~/.codex-dispatcher/tray.log")
                            .show();
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

async fn tokio_sleep(millis: u64) {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(millis));
    })
    .await
    .ok();
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            app.manage(AppState::default());

            let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open in Browser", false, None::<&str>)?;
            let copy_link = MenuItem::with_id(app, "copy", "Copy Phone Link", false, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart", false, None::<&str>)?;
            let login = MenuItem::with_id(
                app,
                "login",
                "Log in to Relay…",
                !relay_configured(),
                None::<&str>,
            )?;
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at Login",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &PredefinedMenuItem::separator(app)?,
                    &open,
                    &copy_link,
                    &restart,
                    &login,
                    &PredefinedMenuItem::separator(app)?,
                    &autostart_item,
                    &quit,
                ],
            )?;

            app.manage(TrayMenu {
                status,
                open,
                copy_link,
                restart,
                login,
            });

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some((local, _)) = current_urls(app) {
                            let _ = app.opener().open_url(local, None::<&str>);
                        }
                    }
                    "copy" => {
                        if let Some((local, phone)) = current_urls(app) {
                            let _ = app.clipboard().write_text(phone.unwrap_or(local));
                        }
                    }
                    "restart" => {
                        stop_serve(app);
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            for _ in 0..50 {
                                if app.state::<AppState>().serve_pid.lock().unwrap().is_none() {
                                    break;
                                }
                                tokio_sleep(100).await;
                            }
                            spawn_serve(&app);
                        });
                    }
                    "login" => run_relay_login(app),
                    "autostart" => {
                        let autolaunch = app.autolaunch();
                        let enabled = autolaunch.is_enabled().unwrap_or(false);
                        let result = if enabled {
                            autolaunch.disable()
                        } else {
                            autolaunch.enable()
                        };
                        if let Err(error) = result {
                            log_line(&format!("autostart toggle failed: {error}"));
                        }
                    }
                    "quit" => {
                        let state = app.state::<AppState>();
                        state.quitting.store(true, Ordering::SeqCst);
                        stop_serve(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            spawn_serve(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            // Tray-only app: no windows exist, so an implicit exit request
            // (code None) must not shut it down; only Quit passes a code.
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
