// A real AppKit event loop is needed: Tauri's mock runtime executes dispatched
// closures inline, hiding the clipboard/WebKit thread race. The harness must
// own main(), since libtest runs #[test] bodies on worker threads.
#[cfg(target_os = "macos")]
#[path = "../src/clipboard.rs"]
mod clipboard;

#[cfg(target_os = "macos")]
mod native {
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    pub static OFF_MAIN: AtomicBool = AtomicBool::new(false);
    pub static READS: AtomicUsize = AtomicUsize::new(0);
    pub static CLEARS: AtomicUsize = AtomicUsize::new(0);
    pub static WRITES: AtomicUsize = AtomicUsize::new(0);
    pub static FAIL_WRITE: AtomicBool = AtomicBool::new(false);

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn class_getInstanceMethod(class: *mut c_void, selector: *mut c_void) -> *mut c_void;
        fn method_setImplementation(method: *mut c_void, imp: *const c_void) -> *const c_void;
    }

    fn record(counter: &AtomicUsize) {
        counter.fetch_add(1, Ordering::SeqCst);
        if unsafe { libc::pthread_main_np() } == 0 {
            OFF_MAIN.store(true, Ordering::SeqCst);
        }
    }

    extern "C" fn read(_board: *mut c_void, _selector: *mut c_void) -> *mut c_void {
        record(&READS);
        std::ptr::null_mut()
    }

    extern "C" fn clear(_board: *mut c_void, _selector: *mut c_void) -> isize {
        record(&CLEARS);
        0
    }

    extern "C" fn write(
        _board: *mut c_void,
        _selector: *mut c_void,
        _objects: *mut c_void,
    ) -> bool {
        record(&WRITES);
        !FAIL_WRITE.load(Ordering::SeqCst)
    }

    pub unsafe fn install() {
        // Intercept the native boundary so the test cannot read or replace the
        // user's clipboard. These IMPs use each selector's Objective-C ABI and
        // live for this dedicated process; all real plugin code still executes.
        let class = objc_getClass(c"NSPasteboard".as_ptr());
        assert!(!class.is_null());
        for (name, implementation) in [
            (c"pasteboardItems", read as *const c_void),
            (c"clearContents", clear as *const c_void),
            (c"writeObjects:", write as *const c_void),
        ] {
            let method = class_getInstanceMethod(class, sel_registerName(name.as_ptr()));
            assert!(!method.is_null());
            method_setImplementation(method, implementation);
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    use std::sync::atomic::Ordering;

    unsafe { native::install() };
    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build clipboard test app");
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    let handle = app.handle().clone();
    let task = tauri::async_runtime::spawn(async move {
        // IPC async commands start on a Tokio worker, just as in the crash.
        assert_eq!(unsafe { libc::pthread_main_np() }, 0);
        let read = clipboard::clipboard_read_text(handle.clone()).await;
        let write = clipboard::clipboard_write_text(handle.clone(), "test 中文\n".into()).await;
        native::FAIL_WRITE.store(true, Ordering::SeqCst);
        let failed_write = clipboard::clipboard_write_text(handle.clone(), "".into()).await;
        handle.exit(0);
        (read, write, failed_write)
    });
    let watchdog = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(10));
        eprintln!("FAIL: clipboard command stalled the event loop");
        watchdog.exit(1);
        std::process::exit(1);
    });
    assert_eq!(app.run_return(|_, _| {}), 0);
    let (read, write, failed_write) = tauri::async_runtime::block_on(task).unwrap();
    assert!(read.unwrap_err().contains("NSPasteboard#pasteboardItems"));
    assert!(write.is_ok());
    assert!(failed_write
        .unwrap_err()
        .contains("NSPasteboard#writeObjects"));
    assert_eq!(native::READS.load(Ordering::SeqCst), 1);
    assert_eq!(native::CLEARS.load(Ordering::SeqCst), 2);
    assert_eq!(native::WRITES.load(Ordering::SeqCst), 2);
    assert!(
        !native::OFF_MAIN.load(Ordering::SeqCst),
        "clipboard accessed NSPasteboard off the main thread, racing WebKit"
    );
    println!("PASS: clipboard commands use the main thread and propagate native errors");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
