use std::io::Write;

use serde_json::{json, Map, Value};

use crate::{AutomationService, Backend, ToolError, MAX_OUTPUT_FRAME_BYTES};

const MAX_ARGUMENT_COUNT: usize = 32;
const MAX_ARGUMENT_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliOutcome {
    Success,
    UsageError,
    RuntimeError,
}

impl CliOutcome {
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Success => 0,
            Self::UsageError => 2,
            Self::RuntimeError => 1,
        }
    }
}

pub fn run_cli<B, F>(
    arguments: &[String],
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    create_service: F,
) -> CliOutcome
where
    B: Backend,
    F: FnOnce() -> Result<AutomationService<B>, ToolError>,
{
    if arguments.len() > MAX_ARGUMENT_COUNT
        || arguments.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_BYTES
    {
        let error = ToolError::invalid("Command line exceeded the bounded input limit");
        let _ = write_json(stderr, &json!({ "error": error }));
        return CliOutcome::UsageError;
    }
    if arguments.is_empty()
        || arguments[0] == "help"
        || arguments[0] == "--help"
        || arguments[0] == "-h"
    {
        let _ = stdout.write_all(help_text().as_bytes());
        return CliOutcome::Success;
    }
    if arguments[0] == "--version" || arguments[0] == "version" {
        let _ = writeln!(stdout, "candorctl {}", env!("CARGO_PKG_VERSION"));
        return CliOutcome::Success;
    }

    let (tool, tool_arguments) = match parse_command(arguments) {
        Ok(command) => command,
        Err(error) => {
            let _ = write_json(stderr, &json!({ "error": error }));
            return CliOutcome::UsageError;
        }
    };
    let mut service = match create_service() {
        Ok(service) => service,
        Err(error) => {
            let _ = write_json(stderr, &json!({ "error": error }));
            return CliOutcome::RuntimeError;
        }
    };
    match service.invoke(tool, tool_arguments) {
        Ok(result) => match write_json(stdout, &result) {
            Ok(()) => CliOutcome::Success,
            Err(error) => {
                let _ = write_json(stderr, &json!({ "error": error }));
                CliOutcome::RuntimeError
            }
        },
        Err(error) => {
            let outcome = if error.code == "INPUT_INVALID" || error.code == "OPERATION_DENIED" {
                CliOutcome::UsageError
            } else {
                CliOutcome::RuntimeError
            };
            let _ = write_json(stderr, &json!({ "error": error }));
            outcome
        }
    }
}

fn parse_command(arguments: &[String]) -> Result<(&'static str, Value), ToolError> {
    let command = arguments[0].as_str();
    let mut positionals = Vec::<String>::new();
    let mut options = Map::<String, Value>::new();
    let mut index = 1_usize;
    while index < arguments.len() {
        let argument = &arguments[index];
        if !argument.starts_with("--") {
            if argument.len() > 512 {
                return Err(ToolError::invalid("Positional argument exceeded 512 bytes"));
            }
            positionals.push(argument.clone());
            index += 1;
            continue;
        }
        let (key, target) = match argument.as_str() {
            "--limit" => ("limit", "integer"),
            "--cursor" => ("cursor", "string"),
            "--format" => ("format", "string"),
            _ => return Err(ToolError::invalid("Unknown command option")),
        };
        index += 1;
        let value = arguments
            .get(index)
            .ok_or_else(|| ToolError::invalid("Command option requires a value"))?;
        if options.contains_key(key) {
            return Err(ToolError::invalid("Command option was repeated"));
        }
        let value = if target == "integer" {
            let parsed = value
                .parse::<u64>()
                .map_err(|_| ToolError::invalid("limit must be a positive integer"))?;
            Value::Number(parsed.into())
        } else {
            Value::String(value.clone())
        };
        options.insert(key.to_string(), value);
        index += 1;
    }

    match command {
        "list" => {
            require_positionals(&positionals, 0)?;
            reject_options(&options, &["limit", "cursor"])?;
            Ok(("list_meetings", Value::Object(options)))
        }
        "search" => {
            require_positionals(&positionals, 1)?;
            reject_options(&options, &["limit", "cursor"])?;
            options.insert("query".to_string(), Value::String(positionals[0].clone()));
            Ok(("search_meetings", Value::Object(options)))
        }
        "summary" => {
            require_positionals(&positionals, 1)?;
            reject_options(&options, &[])?;
            options.insert(
                "recordingId".to_string(),
                Value::String(positionals[0].clone()),
            );
            Ok(("meeting_summary", Value::Object(options)))
        }
        "transcript" => {
            require_positionals(&positionals, 1)?;
            reject_options(&options, &["limit", "cursor"])?;
            options.insert(
                "recordingId".to_string(),
                Value::String(positionals[0].clone()),
            );
            Ok(("get_transcript", Value::Object(options)))
        }
        "export" => {
            require_positionals(&positionals, 1)?;
            reject_options(&options, &["limit", "cursor", "format"])?;
            options.insert(
                "recordingId".to_string(),
                Value::String(positionals[0].clone()),
            );
            Ok(("export_meeting", Value::Object(options)))
        }
        "stats" => {
            require_positionals(&positionals, 0)?;
            reject_options(&options, &[])?;
            Ok(("library_statistics", json!({})))
        }
        _ => Err(ToolError::denied(
            "Command is not on the read-only allowlist",
        )),
    }
}

fn require_positionals(values: &[String], expected: usize) -> Result<(), ToolError> {
    if values.len() == expected {
        Ok(())
    } else {
        Err(ToolError::invalid(format!(
            "Command requires exactly {expected} positional argument(s)"
        )))
    }
}

fn reject_options(options: &Map<String, Value>, allowed: &[&str]) -> Result<(), ToolError> {
    if options.keys().all(|key| allowed.contains(&key.as_str())) {
        Ok(())
    } else {
        Err(ToolError::invalid("Option is not valid for this command"))
    }
}

fn write_json(writer: &mut impl Write, value: &Value) -> Result<(), ToolError> {
    let encoded = serde_json::to_vec(value)
        .map_err(|_| ToolError::internal("Could not encode the command result"))?;
    if encoded.len() > MAX_OUTPUT_FRAME_BYTES {
        return Err(ToolError::internal(
            "Command result exceeded the bounded output limit",
        ));
    }
    writer
        .write_all(&encoded)
        .and_then(|_| writer.write_all(b"\n"))
        .map_err(|_| ToolError::unavailable("Command output was closed"))
}

fn help_text() -> &'static str {
    "candorctl read-only local meeting access\n\n\
Usage:\n\
  candorctl list [--limit N] [--cursor N]\n\
  candorctl search QUERY [--limit N] [--cursor N]\n\
  candorctl summary RECORDING_ID\n\
  candorctl transcript RECORDING_ID [--limit N] [--cursor N]\n\
  candorctl export RECORDING_ID [--format markdown|text] [--limit N] [--cursor N]\n\
  candorctl stats\n\n\
All results are bounded JSON on stdout. The export command returns content in the JSON result and never accepts a filesystem destination.\n"
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    struct MockBackend {
        responses: VecDeque<Value>,
    }

    impl Backend for MockBackend {
        fn call(&mut self, _method: &str, _params: Value) -> Result<Value, ToolError> {
            self.responses
                .pop_front()
                .ok_or_else(|| ToolError::internal("missing response"))
        }
    }

    #[test]
    fn help_does_not_start_core() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut factory_called = false;
        let outcome =
            run_cli::<MockBackend, _>(&["--help".to_string()], &mut stdout, &mut stderr, || {
                factory_called = true;
                Err(ToolError::internal("should not run"))
            });
        assert_eq!(outcome, CliOutcome::Success);
        assert!(!factory_called);
        assert!(String::from_utf8(stdout).unwrap().contains("read-only"));
    }

    #[test]
    fn list_command_writes_bounded_pathless_json() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let outcome = run_cli(
            &["list".to_string(), "--limit".to_string(), "1".to_string()],
            &mut stdout,
            &mut stderr,
            || {
                Ok(AutomationService::new(MockBackend {
                    responses: VecDeque::from([json!({
                        "recordings": [],
                        "totalCount": 0,
                        "hasMore": false
                    })]),
                }))
            },
        );
        assert_eq!(outcome, CliOutcome::Success);
        assert!(stderr.is_empty());
        let value: Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(value["rawPathExposed"], false);
        assert_eq!(value["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn unknown_command_is_rejected_before_core_start() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut factory_called = false;
        let outcome = run_cli::<MockBackend, _>(
            &["delete".to_string(), "abc".to_string()],
            &mut stdout,
            &mut stderr,
            || {
                factory_called = true;
                Err(ToolError::internal("should not run"))
            },
        );
        assert_eq!(outcome, CliOutcome::UsageError);
        assert!(!factory_called);
        let value: Value = serde_json::from_slice(&stderr).unwrap();
        assert_eq!(value["error"]["code"], "OPERATION_DENIED");
    }

    #[test]
    fn arbitrary_destination_path_is_not_a_valid_option() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let outcome = run_cli::<MockBackend, _>(
            &[
                "export".to_string(),
                "abc".to_string(),
                "--output".to_string(),
                "C:/somewhere".to_string(),
            ],
            &mut stdout,
            &mut stderr,
            || Err(ToolError::internal("should not run")),
        );
        assert_eq!(outcome, CliOutcome::UsageError);
    }
}
