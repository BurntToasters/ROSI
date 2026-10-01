//! Release-only verifier for Tauri updater artifact/signature pairs.

use minisign_verify::{PublicKey, Signature};
use std::io::Read;

fn main() -> Result<(), String> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() < 3 || args.len() % 2 == 0 {
        return Err(
            "usage: verify_updater_signatures <public-key> <artifact> <signature> [...]"
                .to_string(),
        );
    }

    let public_key_text = std::fs::read_to_string(&args[0])
        .map_err(|error| format!("could not read updater public key: {error}"))?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("invalid updater public key: {error}"))?;

    for pair in args[1..].as_chunks::<2>().0 {
        let artifact = std::path::Path::new(&pair[0]);
        let signature_text = std::fs::read_to_string(&pair[1]).map_err(|error| {
            format!(
                "could not read signature for {}: {error}",
                artifact.display()
            )
        })?;
        let signature = Signature::decode(&signature_text)
            .map_err(|error| format!("invalid signature for {}: {error}", artifact.display()))?;
        let mut verifier = public_key.verify_stream(&signature).map_err(|error| {
            format!(
                "could not initialize verification for {}: {error}",
                artifact.display()
            )
        })?;
        let mut file = std::fs::File::open(artifact)
            .map_err(|error| format!("could not open {}: {error}", artifact.display()))?;
        // Heap buffer: a 1 MiB stack array overflows Windows' default ~1 MiB stack
        // (STATUS_STACK_OVERFLOW / exit 3221225725) when verifying large installers.
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("could not read {}: {error}", artifact.display()))?;
            if read == 0 {
                break;
            }
            verifier.update(&buffer[..read]);
        }
        verifier.finalize().map_err(|error| {
            format!(
                "updater signature does not match {}: {error}",
                artifact.display()
            )
        })?;
        println!("verified updater signature: {}", artifact.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";

    #[test]
    fn rejects_signature_for_different_artifact() {
        let public_key = PublicKey::decode(PUBLIC_KEY).expect("public key");
        let signature = Signature::decode(SIGNATURE).expect("signature");
        public_key
            .verify(b"test", &signature, false)
            .expect("matching artifact");
        assert!(public_key
            .verify(b"swapped artifact", &signature, false)
            .is_err());
    }
}
