fn main() {
    for rel in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "../../docs/01-当前版/变更记录.md",
    ] {
        println!("cargo:rerun-if-changed={rel}");
    }
    tauri_build::build()
}
