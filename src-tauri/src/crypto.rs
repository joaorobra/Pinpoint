//! Cryptographic core for PINPOINT's encryption-at-rest (locked vaults/folders).
//!
//! This module is deliberately self-contained: no filesystem, no Tauri, no app state. It only knows
//! about bytes, passwords, and keys, which makes it unit-testable in isolation and keeps the security
//! surface small. The lock-manifest / file-flow logic lives in `lock.rs`; this is just the primitives.
//!
//! # Design
//!
//! Two-level key hierarchy so changing a password is cheap and folder locks nest inside vault locks:
//!
//! ```text
//!   password ──Argon2id(salt)──▶ KEK (key-encryption key, 32 bytes, never stored)
//!                                  │ wraps
//!                                  ▼
//!                                 DEK (data-encryption key, 32 bytes, random per locked scope)
//!                                  │ encrypts
//!                                  ▼
//!                                 file bytes  (each file: random nonce + AEAD)
//! ```
//!
//! - **KEK** is derived from the password on every unlock and never persisted. Changing the password
//!   re-derives a new KEK and re-wraps the *same* DEK — no file needs re-encrypting.
//! - **DEK** is a random 32-byte key generated once when a scope is first locked. It is stored only in
//!   wrapped (encrypted) form in the lock manifest, and held in plaintext in process memory only while
//!   the scope is unlocked.
//! - **Cipher** is XChaCha20-Poly1305: an AEAD (so tampering is detected) with a 192-bit nonce, large
//!   enough to pick at random per message without birthday-collision worry.
//! - **KDF** is Argon2id with deliberately heavy parameters (memory-hard) to resist offline guessing.
//!
//! All key material is wrapped in [`Zeroizing`] so it is scrubbed from memory on drop.

use anyhow::{anyhow, Context, Result};
use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Length of a symmetric key (KEK and DEK), in bytes. 256-bit.
pub const KEY_LEN: usize = 32;
/// Length of the Argon2id salt, in bytes.
pub const SALT_LEN: usize = 16;
/// Length of an XChaCha20-Poly1305 nonce, in bytes (192-bit).
pub const NONCE_LEN: usize = 24;

/// Argon2id work factors. Tuned for an interactive desktop unlock (~hundreds of ms) while staying
/// painful to brute-force offline. Stored in the manifest so a future tuning change can still open
/// old vaults using *their* recorded parameters (see [`KdfParams`]).
const ARGON_MEM_KIB: u32 = 64 * 1024; // 64 MiB
const ARGON_ITERS: u32 = 3;
const ARGON_LANES: u32 = 1;

/// A 256-bit symmetric key, zeroized on drop. Used for both the KEK and the DEK.
pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// Argon2id parameters recorded alongside a salt, so the exact KDF used to lock a scope can be
/// reproduced on unlock even if the in-code defaults later change.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub mem_kib: u32,
    pub iters: u32,
    pub lanes: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams {
            mem_kib: ARGON_MEM_KIB,
            iters: ARGON_ITERS,
            lanes: ARGON_LANES,
        }
    }
}

/// Fill a buffer with cryptographically-secure random bytes from the OS CSPRNG.
///
/// `getrandom` pulls from the OS entropy source (BCryptGenRandom on Windows, getrandom(2) on Linux,
/// SecRandomCopyBytes on macOS), so it never silently produces low-entropy output.
pub fn random_bytes(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|e| anyhow!("OS RNG failed: {e}"))?;
    Ok(())
}

/// Generate a fresh random salt for password derivation.
pub fn new_salt() -> Result<[u8; SALT_LEN]> {
    let mut salt = [0u8; SALT_LEN];
    random_bytes(&mut salt)?;
    Ok(salt)
}

/// Generate a fresh random Data-Encryption Key. Returned zeroizing so it scrubs on drop.
pub fn new_dek() -> Result<Key> {
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    random_bytes(dek.as_mut())?;
    Ok(dek)
}

/// Derive a Key-Encryption Key from a password using Argon2id with the given salt/params.
///
/// Deterministic: same (password, salt, params) ⇒ same KEK. This is what lets us re-derive the KEK
/// on each unlock without storing it.
pub fn derive_kek(password: &str, salt: &[u8], params: &KdfParams) -> Result<Key> {
    let argon_params = argon2::Params::new(
        params.mem_kib,
        params.iters,
        params.lanes,
        Some(KEY_LEN),
    )
    .map_err(|e| anyhow!("invalid Argon2 params: {e}"))?;
    let argon = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon_params,
    );
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, kek.as_mut())
        .map_err(|e| anyhow!("Argon2 derivation failed: {e}"))?;
    Ok(kek)
}

/// An AEAD-sealed blob: a random nonce prepended to the ciphertext+tag. Self-describing, so the
/// caller never has to track nonces separately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sealed {
    /// 24-byte XChaCha20-Poly1305 nonce.
    pub nonce: Vec<u8>,
    /// Ciphertext with the 16-byte Poly1305 tag appended (as produced by the AEAD).
    pub ct: Vec<u8>,
}

/// Coerce a key slice to the fixed-size array the cipher needs, rejecting a wrong length rather than
/// panicking. Lets callers pass `&[u8]` (including a `Zeroizing<[u8;32]>` deref) without ceremony.
fn key_array(key: &[u8]) -> Result<&[u8; KEY_LEN]> {
    key.try_into().map_err(|_| anyhow!("key must be {KEY_LEN} bytes"))
}

/// Encrypt `plaintext` under `key` with a fresh random nonce. `aad` is authenticated-but-not-encrypted
/// associated data — bind context here (e.g. a file's rel-path) so a blob can't be silently swapped to
/// another location. Pass `b""` when no binding is needed.
pub fn seal(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<Sealed> {
    let cipher = XChaCha20Poly1305::new(key_array(key)?.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    random_bytes(&mut nonce_bytes)?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| anyhow!("encryption failed"))?;
    Ok(Sealed {
        nonce: nonce_bytes.to_vec(),
        ct,
    })
}

/// Decrypt a [`Sealed`] blob under `key`, verifying the tag and `aad`. Returns an error on any
/// mismatch — wrong key, corrupted ciphertext, or mismatched associated data — without revealing
/// which (a deliberate property of AEAD: failures are indistinguishable).
pub fn open(key: &[u8], sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>> {
    if sealed.nonce.len() != NONCE_LEN {
        return Err(anyhow!("bad nonce length"));
    }
    let cipher = XChaCha20Poly1305::new(key_array(key)?.into());
    let nonce = XNonce::from_slice(&sealed.nonce);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &sealed.ct,
                aad,
            },
        )
        .map_err(|_| anyhow!("decryption failed (wrong password or corrupted data)"))
}

/// Wrap (encrypt) a DEK under a KEK for storage in the lock manifest. The wrapped form is what lands
/// on disk; the raw DEK never does.
pub fn wrap_dek(kek: &[u8], dek: &Key) -> Result<Sealed> {
    seal(kek, dek.as_ref(), b"pinpoint-dek-v1")
}

/// Unwrap (decrypt) a DEK using a KEK derived from the password. A failure here is exactly how a
/// wrong password is detected, so callers surface it as "wrong password".
pub fn unwrap_dek(kek: &[u8], wrapped: &Sealed) -> Result<Key> {
    let raw = open(kek, wrapped, b"pinpoint-dek-v1").context("unwrap DEK")?;
    if raw.len() != KEY_LEN {
        return Err(anyhow!("unwrapped DEK has wrong length"));
    }
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    dek.copy_from_slice(&raw);
    // `raw` is a plain Vec; scrub the transient copy before it drops.
    let mut raw = raw;
    use zeroize::Zeroize;
    raw.zeroize();
    Ok(dek)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_from(byte: u8) -> [u8; KEY_LEN] {
        [byte; KEY_LEN]
    }

    #[test]
    fn seal_open_round_trips() {
        let key = key_from(7);
        let msg = b"the quick brown fox jumps over the lazy dog";
        let sealed = seal(&key, msg, b"aad").unwrap();
        let opened = open(&key, &sealed, b"aad").unwrap();
        assert_eq!(opened, msg);
    }

    #[test]
    fn open_fails_with_wrong_key() {
        let sealed = seal(&key_from(1), b"secret", b"").unwrap();
        assert!(open(&key_from(2), &sealed, b"").is_err());
    }

    #[test]
    fn open_fails_with_wrong_aad() {
        let key = key_from(9);
        let sealed = seal(&key, b"secret", b"path/a.md").unwrap();
        // Right key, but the blob was bound to a different location.
        assert!(open(&key, &sealed, b"path/b.md").is_err());
    }

    #[test]
    fn open_fails_on_tamper() {
        let key = key_from(3);
        let mut sealed = seal(&key, b"secret message", b"").unwrap();
        sealed.ct[0] ^= 0xff; // flip a ciphertext bit
        assert!(open(&key, &sealed, b"").is_err());
    }

    #[test]
    fn nonces_differ_between_seals() {
        let key = key_from(5);
        let a = seal(&key, b"x", b"").unwrap();
        let b = seal(&key, b"x", b"").unwrap();
        // Random nonce per message ⇒ identical plaintext yields different nonces and ciphertexts.
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ct, b.ct);
    }

    #[test]
    fn dek_wrap_unwrap_with_password() {
        let salt = new_salt().unwrap();
        let params = KdfParams::default_fast_for_test();
        let kek = derive_kek("correct horse battery staple", &salt, &params).unwrap();

        let dek = new_dek().unwrap();
        let wrapped = wrap_dek(kek.as_ref(), &dek).unwrap();
        let recovered = unwrap_dek(kek.as_ref(), &wrapped).unwrap();
        assert_eq!(dek.as_ref(), recovered.as_ref());
    }

    #[test]
    fn wrong_password_fails_to_unwrap_dek() {
        let salt = new_salt().unwrap();
        let params = KdfParams::default_fast_for_test();
        let good = derive_kek("right-password", &salt, &params).unwrap();
        let bad = derive_kek("wrong-password", &salt, &params).unwrap();

        let dek = new_dek().unwrap();
        let wrapped = wrap_dek(good.as_ref(), &dek).unwrap();
        assert!(unwrap_dek(bad.as_ref(), &wrapped).is_err());
    }

    #[test]
    fn same_password_and_salt_derive_same_kek() {
        let salt = new_salt().unwrap();
        let p = KdfParams::default_fast_for_test();
        let a = derive_kek("pw", &salt, &p).unwrap();
        let b = derive_kek("pw", &salt, &p).unwrap();
        assert_eq!(a.as_ref(), b.as_ref());
    }

    // Heavy Argon2 params make tests slow; use a light profile for the KDF-exercising tests.
    impl KdfParams {
        fn default_fast_for_test() -> Self {
            KdfParams {
                mem_kib: 8,
                iters: 1,
                lanes: 1,
            }
        }
    }
}
