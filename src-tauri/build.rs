fn valid_github_token(token: &str) -> bool {
    let token = token.trim();
    (20..=512).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_graphic())
}

fn require_release_token() {
    let token = std::env::var("STREAMSPLEASE_GITHUB_TOKEN").unwrap_or_default();
    let release_build = std::env::var("PROFILE").as_deref() == Ok("release");
    if release_build && !valid_github_token(&token) {
        panic!("STREAMSPLEASE_GITHUB_TOKEN must contain the read-only release token");
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=STREAMSPLEASE_GITHUB_TOKEN");
    require_release_token();
    tauri_build::build()
}
