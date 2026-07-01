use std::collections::HashMap;
use std::path::Path;

/// Load `.env` from the repo root (parent of `src-tauri`) into a map.
fn load_dotenv() -> HashMap<String, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let env_path = manifest_dir.join("..").join(".env");
    println!("cargo:rerun-if-changed={}", env_path.display());

    let mut vars = HashMap::new();
    let Ok(content) = std::fs::read_to_string(&env_path) else {
        return vars;
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_string();
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len() - 1].to_string();
        }
        vars.insert(key, value);
    }
    vars
}

/// Prefer process env, then `.env`, for a key.
fn env_value(dotenv: &HashMap<String, String>, key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .or_else(|| dotenv.get(key).cloned())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Emit release-safe compile-time vars from `.env`.
fn export_oauth_env(dotenv: &HashMap<String, String>) {
    let mappings = [
        ("CANDOR_MS_CLIENT_ID", "VITE_MS_CLIENT_ID"),
        ("CANDOR_GOOGLE_CLIENT_ID", "VITE_GOOGLE_CLIENT_ID"),
        ("CANDOR_SHA256_TINY_EN", "CANDOR_SHA256_TINY_EN"),
        ("CANDOR_SHA256_BASE_EN", "CANDOR_SHA256_BASE_EN"),
        ("CANDOR_SHA256_SMALL_EN", "CANDOR_SHA256_SMALL_EN"),
    ];

    for (candor_key, vite_fallback) in mappings {
        let value = env_value(dotenv, candor_key).or_else(|| {
            if candor_key == vite_fallback {
                None
            } else {
                env_value(dotenv, vite_fallback)
            }
        });
        if let Some(value) = value {
            println!("cargo:rustc-env={candor_key}={value}");
        }
    }
}

fn main() {
    let dotenv = load_dotenv();
    export_oauth_env(&dotenv);
    tauri_build::build();
}
