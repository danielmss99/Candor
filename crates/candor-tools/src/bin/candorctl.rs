use std::env;
use std::io;
use std::process::ExitCode;

use candor_tools::{run_cli, AutomationService, CoreProcess};

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let outcome = run_cli(&arguments, &mut stdout, &mut stderr, || {
        CoreProcess::spawn().map(AutomationService::new)
    });
    ExitCode::from(outcome.exit_code() as u8)
}
