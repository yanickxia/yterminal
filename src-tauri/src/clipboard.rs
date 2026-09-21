use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

async fn on_clipboard_thread<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    #[cfg(target_os = "macos")]
    {
        // arboard's mutex does not cover WebKit's NSPasteboard access. Sharing
        // the UI thread prevents concurrent pasteboard ownership/cache updates.
        let (send, receive) = tokio::sync::oneshot::channel();
        let dispatcher = app.clone();
        dispatcher
            .run_on_main_thread(move || {
                let _ = send.send(operation(app));
            })
            .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "clipboard main-thread operation was cancelled".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux clipboard reads can deadlock against WebKit on the UI thread.
        operation(app)
    }
}

#[tauri::command]
pub async fn clipboard_read_text(app: AppHandle) -> Result<String, String> {
    on_clipboard_thread(app, |app| {
        app.clipboard()
            .read_text()
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn clipboard_write_text(app: AppHandle, text: String) -> Result<(), String> {
    on_clipboard_thread(app, move |app| {
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())
    })
    .await
}
