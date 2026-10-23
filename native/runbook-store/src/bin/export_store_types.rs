use runbook_store::{Action, Request};
use ts_rs::TS;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/contracts/src");
    std::fs::create_dir_all(&root)?;
    let text = format!("// Generated from Rust. Do not edit by hand.\nimport type {{ Outcome }} from './generated';\n\nexport {}\n\nexport {}\n", Action::decl(), Request::decl());
    std::fs::write(root.join("actions.ts"), text)?;
    Ok(())
}
