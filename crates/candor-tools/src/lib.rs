mod cli;
mod core_client;
mod mcp;
mod service;

pub use cli::{run_cli, CliOutcome};
pub use core_client::{Backend, CoreProcess, ALLOWED_CORE_METHODS};
pub use mcp::run_mcp;
pub use service::{tool_definitions, AutomationService, ToolError};

pub const PRODUCT_NAME: &str = "Candor read-only automation";
pub const MAX_INPUT_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_TOOL_RESULT_BYTES: usize = 128 * 1024;
