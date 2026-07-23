use tauri::{Emitter, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_blec::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Emit an `app://paused` event to the webview on exit so the JS
      // lifecycle-safety wrapper can fire emergencyStop. Android's native
      // onPause is not a stable Tauri 2.10 RunEvent variant; backgrounding
      // is covered by the JS-side `visibilitychange` listener instead,
      // which Android WebView fires reliably when its host activity
      // transitions to onPause.
      if let RunEvent::ExitRequested { .. } = event {
        let _ = app.emit("app://paused", ());
      }
    });
}
