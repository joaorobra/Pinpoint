//! Lock manifest + file encryption flow for password-protected vaults and folders.
//!
//! Builds on [`crate::crypto`] primitives to turn a directory into an encrypted *scope*. A scope is
//! any folder (the vault root, or a subfolder) marked by a `.pinpoint-lock.json` manifest. The
//! manifest is plaintext metadata — salt, KDF params, a wrapped DEK, and a verifier — that never
//! reveals the password or the DEK.
//!
//! # On-disk model (Phase 1: encrypt/decrypt primitives + manifest)
//!
//! - Locking a scope writes `.pinpoint-lock.json` and (in later phases) rewrites every `.md` inside
//!   as a `<name>.md.enc` ciphertext blob, removing the plaintext.
//! - `.enc` files are JSON-encoded [`crate::crypto::Sealed`] blobs. The file's vault-relative path is
//!   fed in as AEAD associated data, so a blob physically moved to another path fails to decrypt
//!   (defends against copy/rename attacks within the vault).
//! - The manifest's `verifier` is a fixed known-plaintext sealed under the DEK. Decrypting it on
//!   unlock confirms the password is correct *before* we touch any file — wrong password is rejected
//!   fast and unambiguously.
//!
//! This module is host-agnostic (pure filesystem + crypto). The Tauri command layer in `lib.rs` owns
//! the in-memory unlocked-key cache and the session lifecycle.

use crate::crypto::{self, Key, KdfParams, Sealed};
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Filename marking a folder as an encrypted scope. Lives at the scope root; plaintext metadata only.
pub const LOCK_MANIFEST: &str = ".pinpoint-lock.json";
/// Extension appended to encrypted files (e.g. `Note.md` → `Note.md.enc`).
pub const ENC_EXT: &str = "enc";

/// Manifest format version, so future changes can migrate old manifests rather than mis-reading them.
const MANIFEST_VERSION: u32 = 1;
/// Fixed known-plaintext sealed under the DEK to verify the password on unlock.
const VERIFIER_PLAINTEXT: &[u8] = b"pinpoint-lock-verifier-v1";

/// Plaintext metadata for an encrypted scope, stored at `<scope>/.pinpoint-lock.json`.
///
/// Contains nothing secret: the salt and params are needed to derive the KEK from a password, the
/// `wrapped_dek` is the DEK encrypted under that KEK, and `verifier` lets us check the password
/// without decrypting real data. Base64 is used for the byte fields so the file stays human-readable
/// JSON and round-trips through Drive/OneDrive untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockManifest {
    pub version: u32,
    /// Base64 Argon2id salt.
    pub salt: String,
    pub kdf: KdfParams,
    /// DEK wrapped (encrypted) under the password-derived KEK.
    pub wrapped_dek: Sealed,
    /// A known plaintext sealed under the DEK; decrypts iff the password is correct.
    pub verifier: Sealed,
    /// Optional human label shown in the unlock prompt (e.g. "Personal Journal"). Never secret.
    #[serde(default)]
    pub hint: Option<String>,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn unb64(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.as_bytes())
        .context("decode base64 field")
}

/// Path to a scope's lock manifest.
pub fn manifest_path(scope: &Path) -> PathBuf {
    scope.join(LOCK_MANIFEST)
}

/// True if `scope` is an encrypted scope (has a lock manifest). Cheap existence check — does not
/// validate the manifest's contents.
pub fn is_locked_scope(scope: &Path) -> bool {
    manifest_path(scope).exists()
}

/// Read + parse a scope's lock manifest.
pub fn read_manifest(scope: &Path) -> Result<LockManifest> {
    let raw = std::fs::read_to_string(manifest_path(scope))
        .with_context(|| format!("read {LOCK_MANIFEST}"))?;
    let manifest: LockManifest =
        serde_json::from_str(&raw).context("parse lock manifest")?;
    if manifest.version != MANIFEST_VERSION {
        return Err(anyhow!(
            "unsupported lock manifest version {} (this build supports {})",
            manifest.version,
            MANIFEST_VERSION
        ));
    }
    Ok(manifest)
}

fn write_manifest(scope: &Path, manifest: &LockManifest) -> Result<()> {
    std::fs::create_dir_all(scope).ok();
    let raw = serde_json::to_string_pretty(manifest).context("serialize lock manifest")?;
    std::fs::write(manifest_path(scope), raw).with_context(|| format!("write {LOCK_MANIFEST}"))?;
    Ok(())
}

/// Initialize a brand-new encrypted scope: generate a salt + DEK, derive the KEK from `password`,
/// wrap the DEK, build the verifier, and write the manifest. Returns the unwrapped DEK so the caller
/// can immediately encrypt the scope's files in the same operation.
///
/// Does **not** encrypt any files itself — that's the caller's job (kept separate so this stays a
/// pure manifest operation and is independently testable).
pub fn create_scope(scope: &Path, password: &str, hint: Option<String>) -> Result<Key> {
    if is_locked_scope(scope) {
        return Err(anyhow!("this folder is already locked"));
    }
    let salt = crypto::new_salt()?;
    let kdf = KdfParams::default();
    let kek = crypto::derive_kek(password, &salt, &kdf)?;
    let dek = crypto::new_dek()?;
    let wrapped_dek = crypto::wrap_dek(kek.as_ref(), &dek)?;
    let verifier = crypto::seal(dek.as_ref(), VERIFIER_PLAINTEXT, b"pinpoint-verifier")?;

    let manifest = LockManifest {
        version: MANIFEST_VERSION,
        salt: b64(&salt),
        kdf,
        wrapped_dek,
        verifier,
        hint,
    };
    write_manifest(scope, &manifest)?;
    Ok(dek)
}

/// Derive the KEK from a password and recover the scope's DEK, verifying correctness against the
/// manifest's verifier. Returns a clear "wrong password" error on mismatch. This is the unlock path.
pub fn unlock_scope(scope: &Path, password: &str) -> Result<Key> {
    let manifest = read_manifest(scope)?;
    let salt = unb64(&manifest.salt)?;
    let kek = crypto::derive_kek(password, &salt, &manifest.kdf)?;

    // Unwrapping the DEK is the first password check; the verifier is a second, independent one that
    // also confirms the DEK itself is intact.
    let dek = crypto::unwrap_dek(kek.as_ref(), &manifest.wrapped_dek)
        .map_err(|_| anyhow!("wrong password"))?;
    let check = crypto::open(dek.as_ref(), &manifest.verifier, b"pinpoint-verifier")
        .map_err(|_| anyhow!("wrong password"))?;
    if check != VERIFIER_PLAINTEXT {
        return Err(anyhow!("wrong password"));
    }
    Ok(dek)
}

/// Re-wrap the existing DEK under a new password, leaving every encrypted file untouched. Requires
/// the current password to recover the DEK first. This is why the two-level key hierarchy exists:
/// password changes are O(1), not O(files).
pub fn change_password(scope: &Path, old_password: &str, new_password: &str) -> Result<()> {
    let dek = unlock_scope(scope, old_password)?;
    let mut manifest = read_manifest(scope)?;

    let new_salt = crypto::new_salt()?;
    let new_kdf = KdfParams::default();
    let new_kek = crypto::derive_kek(new_password, &new_salt, &new_kdf)?;
    manifest.wrapped_dek = crypto::wrap_dek(new_kek.as_ref(), &dek)?;
    manifest.salt = b64(&new_salt);
    manifest.kdf = new_kdf;
    write_manifest(scope, &manifest)?;
    Ok(())
}

// ---- File-level encrypt/decrypt -----------------------------------------------------------------
// The path is bound as AEAD associated data so a ciphertext can't be silently relocated within the
// vault. `rel_in_scope` is the file's path relative to the *scope root* (forward slashes), stable
// across vault moves.

/// Encrypt a plaintext file's bytes into a serialized `.enc` blob (JSON-encoded [`Sealed`]).
pub fn encrypt_file(dek: &Key, rel_in_scope: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let sealed = crypto::seal(dek.as_ref(), plaintext, rel_in_scope.as_bytes())?;
    serde_json::to_vec(&sealed).context("serialize sealed file")
}

/// Decrypt a `.enc` blob back to plaintext bytes, verifying the path binding.
pub fn decrypt_file(dek: &Key, rel_in_scope: &str, blob: &[u8]) -> Result<Vec<u8>> {
    let sealed: Sealed = serde_json::from_slice(blob).context("parse sealed file")?;
    crypto::open(dek.as_ref(), &sealed, rel_in_scope.as_bytes())
}

/// The encrypted on-disk name for a plaintext file (`Note.md` → `Note.md.enc`).
pub fn enc_name(plain_name: &str) -> String {
    format!("{plain_name}.{ENC_EXT}")
}

/// Recover the plaintext name from an `.enc` file (`Note.md.enc` → `Note.md`), or `None` if it isn't
/// an `.enc` file.
pub fn plain_name(enc_name: &str) -> Option<String> {
    enc_name
        .strip_suffix(&format!(".{ENC_EXT}"))
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_scope(tag: &str) -> PathBuf {
        // Unique-enough per test without needing a time/random source (those are blocked in some
        // sandboxes): use the tag plus the OS temp dir.
        let mut dir = std::env::temp_dir();
        dir.push(format!("pinpoint-lock-test-{tag}"));
        // Start clean.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_then_unlock_recovers_same_dek() {
        let scope = tmp_scope("create-unlock");
        let dek1 = create_scope(&scope, "hunter2", None).unwrap();
        let dek2 = unlock_scope(&scope, "hunter2").unwrap();
        assert_eq!(dek1.as_ref(), dek2.as_ref());
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn unlock_with_wrong_password_is_rejected() {
        let scope = tmp_scope("wrong-pw");
        create_scope(&scope, "right", None).unwrap();
        let err = unlock_scope(&scope, "wrong").unwrap_err();
        assert!(err.to_string().contains("wrong password"));
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn double_lock_is_refused() {
        let scope = tmp_scope("double");
        create_scope(&scope, "pw", None).unwrap();
        assert!(create_scope(&scope, "pw", None).is_err());
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn file_encrypt_decrypt_round_trips() {
        let scope = tmp_scope("file-rt");
        let dek = create_scope(&scope, "pw", None).unwrap();
        let plain = b"# Secret Note\n\nbody text";
        let blob = encrypt_file(&dek, "Secret Note.md", plain).unwrap();
        // The on-disk blob must not contain the plaintext.
        assert!(!blob.windows(plain.len()).any(|w| w == plain));
        let back = decrypt_file(&dek, "Secret Note.md", &blob).unwrap();
        assert_eq!(back, plain);
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn relocated_blob_fails_to_decrypt() {
        let scope = tmp_scope("relocate");
        let dek = create_scope(&scope, "pw", None).unwrap();
        let blob = encrypt_file(&dek, "a.md", b"data").unwrap();
        // Same key, but the path binding differs ⇒ rejected.
        assert!(decrypt_file(&dek, "b.md", &blob).is_err());
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn change_password_keeps_dek_and_files() {
        let scope = tmp_scope("chpw");
        let dek_before = create_scope(&scope, "old", None).unwrap();
        let blob = encrypt_file(&dek_before, "n.md", b"persisted").unwrap();

        change_password(&scope, "old", "new").unwrap();
        assert!(unlock_scope(&scope, "old").is_err());
        let dek_after = unlock_scope(&scope, "new").unwrap();
        // Same DEK ⇒ files encrypted before the change still decrypt.
        assert_eq!(dek_before.as_ref(), dek_after.as_ref());
        assert_eq!(decrypt_file(&dek_after, "n.md", &blob).unwrap(), b"persisted");
        let _ = std::fs::remove_dir_all(&scope);
    }

    #[test]
    fn enc_name_round_trips() {
        assert_eq!(enc_name("Note.md"), "Note.md.enc");
        assert_eq!(plain_name("Note.md.enc").as_deref(), Some("Note.md"));
        assert_eq!(plain_name("Note.md"), None);
    }
}
