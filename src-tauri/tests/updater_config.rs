//! Guards the committed updater configuration: installed copies trust exactly this key and feed.

use serde_json::Value;

fn config() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn updater_trusts_the_wiring_key_and_the_latest_published_release() {
    let c = config();
    let u = &c["plugins"]["updater"];
    assert_eq!(
        u["endpoints"],
        serde_json::json!(["https://github.com/skensell201/wiring/releases/latest/download/latest.json"])
    );
    let pubkey = u["pubkey"].as_str().expect("pubkey");
    // The minisign public key file, base64 as `tauri signer generate` writes it.
    assert!(
        pubkey.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6"),
        "{pubkey}"
    );
    assert_eq!(u["windows"]["installMode"], "passive");
}

#[test]
fn local_builds_do_not_create_updater_artifacts() {
    // The release workflow turns this on with --config; local builds have no signing key.
    assert!(config()["bundle"].get("createUpdaterArtifacts").is_none());
}
