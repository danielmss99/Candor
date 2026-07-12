use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    let Ok(output) = Command::new("xcrun").args(["--find", "swiftc"]).output() else {
        println!("cargo:warning=xcrun was unavailable; using the system Swift runtime rpath only");
        return;
    };
    if !output.status.success() {
        println!("cargo:warning=xcrun could not locate swiftc; using the system Swift runtime rpath only");
        return;
    }

    let swiftc = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let Some(toolchain_usr) = swiftc.parent().and_then(|bin| bin.parent()) else {
        println!("cargo:warning=swiftc path was not inside a toolchain usr/bin directory");
        return;
    };
    let runtime = toolchain_usr.join("lib").join("swift").join("macosx");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", runtime.display());
}
