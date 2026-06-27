//! Android "All files access" (MANAGE_EXTERNAL_STORAGE) helpers, via JNI.
//!
//! PINPOINT keeps its vaults under the device's *public* `Documents/PINPOINT`
//! directory so the `.md` files are visible to every app. On Android 11+ writing
//! there requires the special "All files access" grant, which — unlike normal
//! runtime permissions — can only be toggled by the user on a system Settings
//! screen. This module bridges to the Java side to:
//!   - [`is_manager`]: read `Environment.isExternalStorageManager()`.
//!   - [`open_settings`]: launch `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`
//!     scoped to our package, so the user lands directly on our app's toggle.
//!
//! Everything here is `#[cfg(target_os = "android")]`-only. We reach the running
//! Activity + JavaVM through `ndk_context`, which wry/Tauri populate at startup.

use anyhow::{anyhow, Result};
use jni::objects::{JObject, JValue};
use jni::JavaVM;

/// Run `f` with an attached JNI env and the current Android Activity object.
///
/// `ndk_context::android_context()` **panics** ("android context was not initialized")
/// when called before wry/Tauri populates the process-wide context — which can happen
/// when the frontend invokes one of these commands very early in startup. Because the
/// release profile sets `panic = "abort"`, that panic would kill the whole app instead
/// of surfacing as a command error. We therefore fetch the context inside
/// `catch_unwind` and turn the panic into a recoverable `Err`, so an early call just
/// fails gracefully (the frontend treats "not granted / unknown" and retries on resume).
fn with_activity<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T>,
{
    let ctx = std::panic::catch_unwind(ndk_context::android_context)
        .map_err(|_| anyhow!("android context not initialized yet"))?;
    // SAFETY: ndk_context returns the process-wide VM + Activity that wry set up.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| anyhow!("JavaVM::from_raw failed: {e}"))?;
    let activity = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| anyhow!("attach_current_thread failed: {e}"))?;
    f(&mut env, &activity)
}

/// `Environment.isExternalStorageManager()` — true when "All files access" is granted.
/// Returns `Ok(true)` on Android versions below 11 (the API didn't exist; the legacy
/// WRITE_EXTERNAL_STORAGE permission governs access there and is declared in the manifest).
pub fn is_manager() -> Result<bool> {
    // Below API 30 the method is absent; treat as granted (legacy storage model).
    if android_api_level() < 30 {
        return Ok(true);
    }
    with_activity(|env, _activity| {
        let class = env
            .find_class("android/os/Environment")
            .map_err(|e| anyhow!("find Environment: {e}"))?;
        let res = env
            .call_static_method(class, "isExternalStorageManager", "()Z", &[])
            .map_err(|e| anyhow!("isExternalStorageManager: {e}"))?;
        res.z().map_err(|e| anyhow!("bad bool return: {e}"))
    })
}

/// Launch the per-app "All files access" settings screen
/// (`Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`) with a `package:` URI so
/// the user lands on our toggle directly rather than the full app list. No-op below API 30.
pub fn open_settings() -> Result<()> {
    if android_api_level() < 30 {
        return Ok(());
    }
    with_activity(|env, activity| {
        // action = Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION
        let action = env
            .new_string("android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION")
            .map_err(|e| anyhow!("new action string: {e}"))?;

        // packageName = activity.getPackageName()
        let pkg = env
            .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])
            .map_err(|e| anyhow!("getPackageName: {e}"))?
            .l()
            .map_err(|e| anyhow!("packageName not an object: {e}"))?;
        let pkg_str: String = env
            .get_string((&pkg).into())
            .map_err(|e| anyhow!("read packageName: {e}"))?
            .into();

        // uri = Uri.parse("package:<pkg>")
        let uri_string = env
            .new_string(format!("package:{pkg_str}"))
            .map_err(|e| anyhow!("new uri string: {e}"))?;
        let uri_class = env
            .find_class("android/net/Uri")
            .map_err(|e| anyhow!("find Uri: {e}"))?;
        let uri = env
            .call_static_method(
                uri_class,
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&uri_string)],
            )
            .map_err(|e| anyhow!("Uri.parse: {e}"))?
            .l()
            .map_err(|e| anyhow!("Uri.parse not an object: {e}"))?;

        // intent = new Intent(action, uri)
        let intent_class = env
            .find_class("android/content/Intent")
            .map_err(|e| anyhow!("find Intent: {e}"))?;
        let intent = env
            .new_object(
                &intent_class,
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[JValue::Object(&action), JValue::Object(&uri)],
            )
            .map_err(|e| anyhow!("new Intent: {e}"))?;

        // intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK = 0x10000000)
        env.call_method(&intent, "addFlags", "(I)Landroid/content/Intent;", &[JValue::Int(0x1000_0000)])
            .map_err(|e| anyhow!("addFlags: {e}"))?;

        // activity.startActivity(intent)
        env.call_method(
            activity,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[JValue::Object(&intent)],
        )
        .map_err(|e| anyhow!("startActivity: {e}"))?;

        Ok(())
    })
}

/// `Build.VERSION.SDK_INT`. Returns 0 if it can't be read (callers treat <30 as legacy).
fn android_api_level() -> i32 {
    with_activity(|env, _activity| {
        let class = env
            .find_class("android/os/Build$VERSION")
            .map_err(|e| anyhow!("find Build.VERSION: {e}"))?;
        let sdk = env
            .get_static_field(class, "SDK_INT", "I")
            .map_err(|e| anyhow!("get SDK_INT: {e}"))?;
        sdk.i().map_err(|e| anyhow!("SDK_INT not int: {e}"))
    })
    .unwrap_or(0)
}
