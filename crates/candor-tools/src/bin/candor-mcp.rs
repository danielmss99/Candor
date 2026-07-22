use std::io::{self, BufReader};
use std::process::ExitCode;

use candor_tools::{run_mcp, AutomationService, CoreProcess};

fn main() -> ExitCode {
    let core = match CoreProcess::spawn() {
        Ok(core) => core,
        Err(_) => return ExitCode::FAILURE,
    };
    let mut service = AutomationService::new(core);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    match run_mcp(&mut reader, &mut writer, &mut service) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
