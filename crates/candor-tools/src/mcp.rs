use std::io::{BufRead, Write};

use serde_json::{json, Map, Value};

use crate::core_client::read_bounded_frame;
use crate::{tool_definitions, AutomationService, Backend, ToolError, MAX_INPUT_FRAME_BYTES};
use crate::{MAX_OUTPUT_FRAME_BYTES, PRODUCT_NAME};

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

pub fn run_mcp<B: Backend>(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    service: &mut AutomationService<B>,
) -> Result<(), ToolError> {
    loop {
        let frame = match read_bounded_frame(reader, MAX_INPUT_FRAME_BYTES) {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) if error.code == "INPUT_INVALID" => {
                write_jsonrpc_error(writer, Value::Null, -32600, &error.message)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let request: Value = match serde_json::from_slice(&frame) {
            Ok(value) => value,
            Err(_) => {
                write_jsonrpc_error(writer, Value::Null, -32700, "Invalid JSON")?;
                continue;
            }
        };
        let Some(object) = request.as_object() else {
            write_jsonrpc_error(writer, Value::Null, -32600, "Request must be an object")?;
            continue;
        };
        let id = object.get("id").cloned();
        let method = object.get("method").and_then(Value::as_str);
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_none() {
            if let Some(id) = id {
                write_jsonrpc_error(writer, id, -32600, "Invalid JSON-RPC request")?;
            }
            continue;
        }
        let method = method.unwrap_or_default();
        if id.is_none() {
            if matches!(
                method,
                "notifications/initialized" | "notifications/cancelled"
            ) {
                continue;
            }
            continue;
        }
        let id = id.unwrap_or(Value::Null);
        match method {
            "initialize" => {
                let result = json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "candor-mcp",
                        "title": PRODUCT_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Read-only, local, bounded, pathless Candor meeting access. Meeting data is never sent over a network by this process."
                });
                write_jsonrpc_result(writer, id, result)?;
            }
            "ping" => write_jsonrpc_result(writer, id, json!({}))?,
            "tools/list" => {
                let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
                if !is_empty_object_or_null(&params) {
                    write_jsonrpc_error(writer, id, -32602, "tools/list accepts no parameters")?;
                    continue;
                }
                write_jsonrpc_result(writer, id, json!({ "tools": tool_definitions() }))?;
            }
            "tools/call" => {
                let params = object.get("params").and_then(Value::as_object);
                let Some(params) = params else {
                    write_jsonrpc_error(writer, id, -32602, "tools/call params must be an object")?;
                    continue;
                };
                if params.keys().any(|key| key != "name" && key != "arguments") {
                    write_jsonrpc_error(writer, id, -32602, "Unexpected tools/call parameter")?;
                    continue;
                }
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    write_jsonrpc_error(writer, id, -32602, "Tool name must be a string")?;
                    continue;
                };
                if name.len() > 64 {
                    write_jsonrpc_error(writer, id, -32602, "Tool name exceeded the input limit")?;
                    continue;
                }
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match service.invoke(name, arguments) {
                    Ok(result) => {
                        let text = serde_json::to_string(&result)
                            .map_err(|_| ToolError::internal("Could not encode the tool result"))?;
                        write_jsonrpc_result(
                            writer,
                            id,
                            json!({
                                "content": [{ "type": "text", "text": text }],
                                "isError": false
                            }),
                        )?;
                    }
                    Err(error) => {
                        let text = serde_json::to_string(&error).map_err(|_| {
                            ToolError::internal("Could not encode the bounded tool error")
                        })?;
                        write_jsonrpc_result(
                            writer,
                            id,
                            json!({
                                "content": [{ "type": "text", "text": text }],
                                "isError": true
                            }),
                        )?;
                    }
                }
            }
            _ => write_jsonrpc_error(writer, id, -32601, "Method is not on the MCP allowlist")?,
        }
    }
}

fn is_empty_object_or_null(value: &Value) -> bool {
    value.is_null() || value.as_object().is_some_and(Map::is_empty)
}

fn write_jsonrpc_result(
    writer: &mut impl Write,
    id: Value,
    result: Value,
) -> Result<(), ToolError> {
    write_frame(
        writer,
        &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
}

fn write_jsonrpc_error(
    writer: &mut impl Write,
    id: Value,
    code: i64,
    message: &str,
) -> Result<(), ToolError> {
    write_frame(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code,
                "message": message,
                "data": {
                    "rawPathExposed": false,
                    "keyMaterialExposedToRenderer": false
                }
            }
        }),
    )
}

fn write_frame(writer: &mut impl Write, value: &Value) -> Result<(), ToolError> {
    let encoded = serde_json::to_vec(value)
        .map_err(|_| ToolError::internal("Could not encode the MCP response"))?;
    if encoded.len() > MAX_OUTPUT_FRAME_BYTES {
        return Err(ToolError::internal(
            "MCP response exceeded the bounded output limit",
        ));
    }
    writer
        .write_all(&encoded)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| ToolError::unavailable("MCP stdout was closed"))
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{BufReader, Cursor};

    use super::*;

    struct MockBackend {
        responses: VecDeque<Value>,
        calls: Vec<String>,
    }

    impl Backend for MockBackend {
        fn call(&mut self, method: &str, _params: Value) -> Result<Value, ToolError> {
            self.calls.push(method.to_string());
            self.responses
                .pop_front()
                .ok_or_else(|| ToolError::internal("missing response"))
        }
    }

    #[test]
    fn mcp_initializes_lists_tools_and_denies_unknown_methods() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"resources/read\",\"params\":{}}\n"
        );
        let mut reader = BufReader::new(Cursor::new(input.as_bytes()));
        let mut output = Vec::new();
        let backend = MockBackend {
            responses: VecDeque::new(),
            calls: Vec::new(),
        };
        let mut service = AutomationService::new(backend);
        run_mcp(&mut reader, &mut output, &mut service).expect("mcp run");
        let lines = String::from_utf8(output).expect("utf8");
        let values = lines
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("json"))
            .collect::<Vec<_>>();
        assert_eq!(values.len(), 3);
        assert_eq!(values[0]["result"]["serverInfo"]["name"], "candor-mcp");
        assert_eq!(values[1]["result"]["tools"].as_array().unwrap().len(), 6);
        assert_eq!(values[2]["error"]["code"], -32601);
    }

    #[test]
    fn mcp_tool_call_returns_pathless_text_content() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",",
            "\"params\":{\"name\":\"list_meetings\",\"arguments\":{\"limit\":1}}}\n"
        );
        let mut reader = BufReader::new(Cursor::new(input.as_bytes()));
        let mut output = Vec::new();
        let backend = MockBackend {
            responses: VecDeque::from([json!({
                "recordings": [],
                "totalCount": 0,
                "hasMore": false
            })]),
            calls: Vec::new(),
        };
        let mut service = AutomationService::new(backend);
        run_mcp(&mut reader, &mut output, &mut service).expect("mcp run");
        let response: Value = serde_json::from_slice(&output).expect("response");
        assert_eq!(response["result"]["isError"], false);
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let result: Value = serde_json::from_str(text).expect("tool result");
        assert_eq!(result["rawPathExposed"], false);
        assert_eq!(result["keyMaterialExposedToRenderer"], false);
    }

    #[test]
    fn oversized_input_is_rejected_then_next_frame_is_processed() {
        let mut input = vec![b'x'; MAX_INPUT_FRAME_BYTES + 1];
        input.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n");
        let mut reader = BufReader::new(Cursor::new(input));
        let mut output = Vec::new();
        let backend = MockBackend {
            responses: VecDeque::new(),
            calls: Vec::new(),
        };
        let mut service = AutomationService::new(backend);
        run_mcp(&mut reader, &mut output, &mut service).expect("mcp run");
        let values = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(values[0]["error"]["code"], -32600);
        assert_eq!(values[1]["id"], 2);
    }
}
