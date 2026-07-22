use std::env;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use time::OffsetDateTime;

use crate::service::ToolError;

const CORE_PROTOCOL_VERSION: &str = "m0-jsonrpc-stdio-1";
const MAX_CORE_FRAME_BYTES: usize = 4_000_000;
const MAX_SKIPPED_CORE_FRAMES: usize = 32;
const CORE_BINARY_ENV: &str = "CANDOR_CORE_BINARY";
const CORE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const CORE_SHUTDOWN_RESPONSE_TIMEOUT: Duration = Duration::from_millis(750);
const CHILD_GRACEFUL_REAP_ATTEMPTS: usize = 50;
const CHILD_FORCED_REAP_ATTEMPTS: usize = 50;
const CHILD_REAP_POLL_INTERVAL: Duration = Duration::from_millis(10);

type CoreFrame = Result<Vec<u8>, ToolError>;

#[derive(Debug)]
enum CoreResponseFailure {
    Business(ToolError),
    Transport(ToolError),
}

impl CoreResponseFailure {
    fn into_error(self) -> ToolError {
        match self {
            Self::Business(error) | Self::Transport(error) => error,
        }
    }

    fn poisons_transport(&self) -> bool {
        matches!(self, Self::Transport(_))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ChildCleanup {
    NoChild,
    Reaped,
    ReaperStarted,
    ReaperUnavailable,
}

/// This is the complete set of methods that the automation companions can send
/// to candor-core. `core.shutdown` is lifecycle-only and carries no user data.
pub const ALLOWED_CORE_METHODS: &[&str] = &[
    "recording.durable.listPage",
    "recording.durable.transcriptPage",
    "recording.durable.search",
    "core.shutdown",
];

pub trait Backend {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, ToolError>;
}

pub struct CoreProcess {
    child: Option<Child>,
    input: Option<BufWriter<ChildStdin>>,
    output: Option<Receiver<CoreFrame>>,
    shutdown_started: bool,
}

impl CoreProcess {
    pub fn spawn() -> Result<Self, ToolError> {
        let executable = locate_core_binary()?;
        let mut child = Command::new(&executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("CANDOR_AUTOMATION_MODE", "read-only")
            .spawn()
            .map_err(|_| ToolError::unavailable("Candor core could not be started"))?;
        let input = match child.stdin.take() {
            Some(input) => input,
            None => {
                terminate_and_reap_child(child);
                return Err(ToolError::unavailable("Candor core input was unavailable"));
            }
        };
        let output = match child.stdout.take() {
            Some(output) => output,
            None => {
                drop(input);
                terminate_and_reap_child(child);
                return Err(ToolError::unavailable("Candor core output was unavailable"));
            }
        };
        let output = match spawn_frame_reader(output) {
            Ok(output) => output,
            Err(error) => {
                drop(input);
                terminate_and_reap_child(child);
                return Err(error);
            }
        };
        Ok(Self {
            child: Some(child),
            input: Some(BufWriter::new(input)),
            output: Some(output),
            shutdown_started: false,
        })
    }

    pub fn shutdown(&mut self) {
        if self.shutdown_started {
            return;
        }
        self.shutdown_started = true;
        let _ = self.call_inner_with_timeout(
            "core.shutdown",
            Value::Null,
            CORE_SHUTDOWN_RESPONSE_TIMEOUT,
        );
        self.input.take();
        self.output.take();
        if let Some(child) = self.child.take() {
            gracefully_reap_child(child);
        }
    }

    fn call_inner(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.call_inner_with_timeout(method, params, CORE_RESPONSE_TIMEOUT)
    }

    fn call_inner_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        response_timeout: Duration,
    ) -> Result<Value, ToolError> {
        if !ALLOWED_CORE_METHODS.contains(&method) {
            return Err(ToolError::denied(
                "Core operation is not on the read-only allowlist",
            ));
        }
        let request_id = uuid_v4()?;
        let sent_at = core_timestamp(OffsetDateTime::now_utc());
        let request = json!({
            "id": request_id,
            "requestId": request_id,
            "protocolVersion": CORE_PROTOCOL_VERSION,
            "sentAt": sent_at,
            "method": method,
            "params": params
        });
        let encoded = serde_json::to_vec(&request)
            .map_err(|_| ToolError::internal("Could not encode the core request"))?;
        if encoded.len() > crate::MAX_INPUT_FRAME_BYTES {
            return Err(ToolError::invalid(
                "Request exceeded the automation input limit",
            ));
        }

        let Some(input) = self.input.as_mut() else {
            let error = ToolError::unavailable("Candor core input was closed");
            self.poison_transport();
            return Err(error);
        };
        if input
            .write_all(&encoded)
            .and_then(|_| input.write_all(b"\n"))
            .and_then(|_| input.flush())
            .is_err()
        {
            let error = ToolError::unavailable("Candor core stopped accepting requests");
            self.poison_transport();
            return Err(error);
        }

        let Some(output) = self.output.as_ref() else {
            let error = ToolError::unavailable("Candor core output was closed");
            self.poison_transport();
            return Err(error);
        };
        let response = wait_for_core_response(output, &request_id, response_timeout);
        match response {
            Ok(response) => Ok(response),
            Err(failure) => {
                let poison_transport = failure.poisons_transport();
                let error = failure.into_error();
                if poison_transport {
                    // A late or malformed response must never be mistaken for a
                    // later request. Close both pipes and reap the private child.
                    self.poison_transport();
                }
                Err(error)
            }
        }
    }

    fn poison_transport(&mut self) -> ChildCleanup {
        self.input.take();
        self.output.take();
        self.child
            .take()
            .map(terminate_and_reap_child)
            .unwrap_or(ChildCleanup::NoChild)
    }
}

fn child_reaped(child: &mut Child, attempts: usize) -> bool {
    let attempts = attempts.max(1);
    for attempt in 0..attempts {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if attempt + 1 < attempts {
                    thread::sleep(CHILD_REAP_POLL_INTERVAL);
                }
            }
            Err(_) => return false,
        }
    }
    false
}

fn hand_off_child_reaper(mut child: Child) -> ChildCleanup {
    match thread::Builder::new()
        .name("candor-core-child-reaper".to_string())
        .spawn(move || {
            let _ = child.kill();
            let _ = child.wait();
        }) {
        Ok(_) => ChildCleanup::ReaperStarted,
        Err(_) => ChildCleanup::ReaperUnavailable,
    }
}

fn terminate_and_reap_child(mut child: Child) -> ChildCleanup {
    let _ = child.kill();
    if child_reaped(&mut child, CHILD_FORCED_REAP_ATTEMPTS) {
        ChildCleanup::Reaped
    } else {
        hand_off_child_reaper(child)
    }
}

fn gracefully_reap_child(mut child: Child) -> ChildCleanup {
    if child_reaped(&mut child, CHILD_GRACEFUL_REAP_ATTEMPTS) {
        ChildCleanup::Reaped
    } else {
        terminate_and_reap_child(child)
    }
}

fn spawn_frame_reader(output: ChildStdout) -> Result<Receiver<CoreFrame>, ToolError> {
    // One bounded slot prevents an untrusted or malfunctioning child from
    // accumulating decoded frames while the caller processes a response.
    let (sender, receiver) = sync_channel(1);
    thread::Builder::new()
        .name("candor-core-frame-reader".to_string())
        .spawn(move || {
            let mut output = BufReader::new(output);
            loop {
                let frame = match read_bounded_frame(&mut output, MAX_CORE_FRAME_BYTES) {
                    Ok(Some(frame)) => Ok(frame),
                    Ok(None) => Err(ToolError::unavailable("Candor core closed unexpectedly")),
                    Err(error) => Err(error),
                };
                let terminal = frame.is_err();
                if sender.send(frame).is_err() || terminal {
                    return;
                }
            }
        })
        .map_err(|_| ToolError::unavailable("Candor core response reader could not be started"))?;
    Ok(receiver)
}

fn wait_for_core_response(
    output: &Receiver<CoreFrame>,
    request_id: &str,
    response_timeout: Duration,
) -> Result<Value, CoreResponseFailure> {
    let started_at = Instant::now();
    let deadline = started_at
        .checked_add(response_timeout)
        .unwrap_or(started_at);
    for _ in 0..MAX_SKIPPED_CORE_FRAMES {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| CoreResponseFailure::Transport(ToolError::core_timeout()))?;
        let frame = match output.recv_timeout(remaining) {
            Ok(Ok(frame)) => frame,
            Ok(Err(error)) => return Err(CoreResponseFailure::Transport(error)),
            Err(RecvTimeoutError::Timeout) => {
                return Err(CoreResponseFailure::Transport(ToolError::core_timeout()));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(CoreResponseFailure::Transport(ToolError::unavailable(
                    "Candor core output was closed",
                )));
            }
        };
        let response: Value = serde_json::from_slice(&frame).map_err(|_| {
            CoreResponseFailure::Transport(ToolError::unavailable(
                "Candor core returned an invalid response",
            ))
        })?;
        let matches_request = response.get("requestId").and_then(Value::as_str) == Some(request_id)
            || response.get("id").and_then(Value::as_str) == Some(request_id);
        if !matches_request {
            continue;
        }
        match response.get("ok").and_then(Value::as_bool) {
            Some(false) => {
                let Some(code) = response
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .filter(|value| safe_error_code(value))
                else {
                    return Err(CoreResponseFailure::Transport(ToolError::unavailable(
                        "Candor core returned an invalid response",
                    )));
                };
                let Some(retryable) = response
                    .pointer("/error/retryable")
                    .and_then(Value::as_bool)
                else {
                    return Err(CoreResponseFailure::Transport(ToolError::unavailable(
                        "Candor core returned an invalid response",
                    )));
                };
                return Err(CoreResponseFailure::Business(ToolError::core(
                    code, retryable,
                )));
            }
            Some(true) => {}
            None => {
                return Err(CoreResponseFailure::Transport(ToolError::unavailable(
                    "Candor core returned an invalid response",
                )));
            }
        }
        return response.get("result").cloned().ok_or_else(|| {
            CoreResponseFailure::Transport(ToolError::unavailable("Candor core omitted the result"))
        });
    }
    Err(CoreResponseFailure::Transport(ToolError::unavailable(
        "Candor core did not return the requested response",
    )))
}

impl Backend for CoreProcess {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, ToolError> {
        if method == "core.shutdown" {
            return Err(ToolError::denied(
                "Lifecycle operations are not available as automation tools",
            ));
        }
        self.call_inner(method, params)
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn locate_core_binary() -> Result<PathBuf, ToolError> {
    if let Some(configured) = env::var_os(CORE_BINARY_ENV) {
        let candidate = PathBuf::from(configured);
        if candidate.is_absolute() && is_named_core_binary(&candidate) && candidate.is_file() {
            return Ok(candidate);
        }
        return Err(ToolError::invalid(
            "CANDOR_CORE_BINARY must be an absolute path to an existing candor-core executable",
        ));
    }

    let executable_name = if cfg!(windows) {
        "candor-core.exe"
    } else {
        "candor-core"
    };
    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(executable_name));
        }
    }
    // Developer target-directory fallbacks must never be compiled into release
    // companions. Packaged tools resolve only an adjacent core unless the
    // caller supplies the explicit absolute override above.
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(
            manifest_dir
                .join("..")
                .join("candor-core")
                .join("target")
                .join("debug")
                .join(executable_name),
        );
        candidates.push(
            manifest_dir
                .join("..")
                .join("candor-core")
                .join("target")
                .join("release")
                .join(executable_name),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            ToolError::unavailable(
                "candor-core was not adjacent to the companion; set CANDOR_CORE_BINARY",
            )
        })
}

fn is_named_core_binary(path: &Path) -> bool {
    let file_name = path.file_name().and_then(OsStr::to_str);
    if cfg!(windows) {
        file_name.is_some_and(|value| value.eq_ignore_ascii_case("candor-core.exe"))
    } else {
        file_name == Some("candor-core")
    }
}

fn safe_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn uuid_v4() -> Result<String, ToolError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| ToolError::internal("Could not create a secure request identifier"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

fn core_timestamp(value: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        value.month() as u8,
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    )
}

pub(crate) fn read_bounded_frame(
    reader: &mut impl BufRead,
    limit: usize,
) -> Result<Option<Vec<u8>>, ToolError> {
    let mut frame = Vec::with_capacity(limit.min(8 * 1024));
    let mut oversized = false;
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| ToolError::unavailable("Input stream could not be read"))?;
        if available.is_empty() {
            if oversized {
                return Err(ToolError::invalid("Input frame exceeded the size limit"));
            }
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let payload_len = newline.unwrap_or(available.len());
        if !oversized {
            if frame.len().saturating_add(payload_len) > limit {
                frame.clear();
                oversized = true;
            } else {
                frame.extend_from_slice(&available[..payload_len]);
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return if oversized {
                Err(ToolError::invalid("Input frame exceeded the size limit"))
            } else {
                Ok(Some(frame))
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc::SyncSender;

    const PRIVATE_CHILD_FIXTURE_ENV: &str = "CANDOR_TOOLS_PRIVATE_CHILD_FIXTURE";

    #[test]
    fn private_child_fixture_waits_for_termination() {
        if env::var_os(PRIVATE_CHILD_FIXTURE_ENV).is_none() {
            return;
        }
        println!("CANDOR_PRIVATE_CHILD_READY");
        std::io::stdout().flush().expect("flush fixture readiness");
        loop {
            thread::park();
        }
    }

    #[test]
    fn core_allowlist_contains_no_mutating_product_methods() {
        assert_eq!(
            ALLOWED_CORE_METHODS,
            &[
                "recording.durable.listPage",
                "recording.durable.transcriptPage",
                "recording.durable.search",
                "core.shutdown"
            ]
        );
        assert!(!ALLOWED_CORE_METHODS.iter().any(|method| {
            method.contains("delete")
                || method.contains("save")
                || method.contains("start")
                || method.contains("capture")
                || method.contains("export")
        }));
    }

    #[test]
    fn bounded_reader_discards_oversized_frame_before_returning_error() {
        let bytes = format!("{}\n{{\"ok\":true}}\n", "x".repeat(20));
        let mut reader = BufReader::new(Cursor::new(bytes.into_bytes()));
        let error = read_bounded_frame(&mut reader, 10).expect_err("oversized frame");
        assert_eq!(error.code, "INPUT_INVALID");
        let next = read_bounded_frame(&mut reader, 20)
            .expect("next frame")
            .expect("frame");
        assert_eq!(next, br#"{"ok":true}"#);
    }

    #[test]
    fn generated_request_id_is_uuid_v4() {
        let id = uuid_v4().expect("uuid");
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }

    #[test]
    fn core_timestamp_uses_the_exact_millisecond_contract() {
        let timestamp = core_timestamp(OffsetDateTime::UNIX_EPOCH);
        assert_eq!(timestamp, "1970-01-01T00:00:00.000Z");
        assert_eq!(timestamp.len(), 24);
    }

    #[test]
    fn core_response_wait_has_a_sanitized_wall_clock_timeout() {
        let (_sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
        let started_at = Instant::now();
        let failure = wait_for_core_response(
            &receiver,
            "00000000-0000-4000-8000-000000000000",
            Duration::from_millis(20),
        )
        .expect_err("silent core must time out");
        assert!(failure.poisons_transport());
        let error = failure.into_error();

        assert_eq!(error.code, "CORE_RESPONSE_TIMEOUT");
        assert_eq!(
            error.message,
            "Candor core did not respond within the bounded local timeout"
        );
        assert!(error.retryable);
        assert!(!error.raw_path_exposed);
        assert!(!error.key_material_exposed_to_renderer);
        assert!(started_at.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn unrelated_frames_do_not_reset_the_wall_clock_deadline() {
        let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(2);
        sender
            .send(Ok(
                br#"{"id":"another-request","ok":true,"result":{}}"#.to_vec()
            ))
            .expect("queue unrelated response");
        let started_at = Instant::now();
        let failure = wait_for_core_response(&receiver, "requested-id", Duration::from_millis(20))
            .expect_err("missing response must time out");
        assert!(failure.poisons_transport());
        let error = failure.into_error();

        assert_eq!(error.code, "CORE_RESPONSE_TIMEOUT");
        assert!(started_at.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn matching_response_is_returned_before_the_deadline() {
        let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
        sender
            .send(Ok(
                br#"{"requestId":"requested-id","ok":true,"result":{"count":2}}"#.to_vec(),
            ))
            .expect("queue matching response");

        let response = wait_for_core_response(&receiver, "requested-id", Duration::from_secs(1))
            .expect("matching response");
        assert_eq!(response, json!({ "count": 2 }));
    }

    #[test]
    fn valid_core_business_error_does_not_poison_the_transport() {
        let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
        sender
            .send(Ok(
                br#"{"requestId":"requested-id","ok":false,"error":{"code":"MEETING_NOT_FOUND","retryable":false}}"#
                    .to_vec(),
            ))
            .expect("queue business error");

        let failure = wait_for_core_response(&receiver, "requested-id", Duration::from_secs(1))
            .expect_err("business error");
        assert!(!failure.poisons_transport());
        let error = failure.into_error();
        assert_eq!(error.code, "MEETING_NOT_FOUND");
        assert!(!error.retryable);
    }

    #[test]
    fn malformed_core_business_error_envelopes_poison_the_transport() {
        let frames = [
            br#"{"requestId":"requested-id","ok":false,"error":{"retryable":false}}"#.as_slice(),
            br#"{"requestId":"requested-id","ok":false,"error":{"code":"unsafe-code","retryable":false}}"#.as_slice(),
            br#"{"requestId":"requested-id","ok":false,"error":{"code":"MEETING_NOT_FOUND","retryable":"no"}}"#.as_slice(),
        ];

        for frame in frames {
            let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
            sender
                .send(Ok(frame.to_vec()))
                .expect("queue malformed business error");

            let failure = wait_for_core_response(&receiver, "requested-id", Duration::from_secs(1))
                .expect_err("malformed error envelope is a protocol failure");
            assert!(failure.poisons_transport());
            assert_eq!(failure.into_error().code, "CORE_UNAVAILABLE");
        }
    }

    #[test]
    fn malformed_matching_response_poison_classification_is_terminal() {
        let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
        sender
            .send(Ok(br#"{"requestId":"requested-id","result":{}}"#.to_vec()))
            .expect("queue malformed response");

        let failure = wait_for_core_response(&receiver, "requested-id", Duration::from_secs(1))
            .expect_err("missing ok marker is a protocol failure");
        assert!(failure.poisons_transport());
        assert_eq!(failure.into_error().code, "CORE_UNAVAILABLE");
    }

    #[test]
    fn poisoned_transport_closes_pipes_and_releases_the_private_child() {
        let executable = env::current_exe().expect("current test executable");
        let mut child = Command::new(executable)
            .args([
                "--exact",
                "core_client::tests::private_child_fixture_waits_for_termination",
                "--nocapture",
            ])
            .env(PRIVATE_CHILD_FIXTURE_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn private child fixture");
        let input = child.stdin.take().expect("fixture stdin");
        let output = child.stdout.take().expect("fixture stdout");
        let mut output = BufReader::new(output);
        let mut ready = false;
        for _ in 0..16 {
            let mut line = String::new();
            if output.read_line(&mut line).expect("read fixture output") == 0 {
                break;
            }
            if line.contains("CANDOR_PRIVATE_CHILD_READY") {
                ready = true;
                break;
            }
        }
        assert!(ready, "private child fixture did not become ready");
        drop(output);

        let (sender, receiver): (SyncSender<CoreFrame>, Receiver<CoreFrame>) = sync_channel(1);
        let mut process = CoreProcess {
            child: Some(child),
            input: Some(BufWriter::new(input)),
            output: Some(receiver),
            shutdown_started: false,
        };
        let cleanup = process.poison_transport();

        assert!(matches!(
            cleanup,
            ChildCleanup::Reaped | ChildCleanup::ReaperStarted
        ));
        assert!(process.child.is_none());
        assert!(process.input.is_none());
        assert!(process.output.is_none());
        assert!(sender.send(Ok(Vec::new())).is_err());
    }
}
