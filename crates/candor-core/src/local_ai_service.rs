use serde::Deserialize;
use serde_json::{json, Value};

use crate::local_model_scheduler::LocalModelScheduler;
use crate::recording_store::{
    RecordingIdParams, RecordingStore, RecordingStoreError, StartRecordingParams,
    WriteTranscriptSegmentParams,
};

const MAX_ITEMS_PER_SECTION: usize = 5;
const MAX_QUOTE_CHARS: usize = 180;
const MAX_QUESTION_BYTES: usize = 500;
const MAX_ASK_CITATIONS: usize = 5;

#[derive(Debug)]
pub struct LocalAiError {
    pub code: &'static str,
    pub message: String,
}

impl LocalAiError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<RecordingStoreError> for LocalAiError {
    fn from(error: RecordingStoreError) -> Self {
        Self::new(error.code, error.message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecapParams {
    pub recording_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAskParams {
    pub recording_id: String,
    pub question: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiProofParams {
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug)]
struct RecapSegment {
    index: u64,
    channel: String,
    speaker: String,
    text: String,
    start_ms: u64,
}

#[derive(Default)]
pub struct LocalAiService;

impl LocalAiService {
    pub fn status(&self, scheduler: &LocalModelScheduler) -> Value {
        json!({
            "implemented": true,
            "localOnly": true,
            "cloudAi": false,
            "engine": "heuristic-local",
            "heuristicRecapImplemented": true,
            "actionExtractionImplemented": true,
            "decisionExtractionImplemented": true,
            "riskExtractionImplemented": true,
            "heuristicAskImplemented": true,
            "instructModelPreflightImplemented": true,
            "instructModelImplemented": true,
            "instructModelAskImplemented": true,
            "instructModelRecapImplemented": true,
            "instructModelRequiresLocalBinaryAndGguf": true,
            "instructModelStatusMethod": "ai.instructStatus",
            "askImplemented": true,
            "askMode": "heuristic-local-extractive",
            "embeddingsImplemented": false,
            "modelRequiredForHeuristics": false,
            "llmSchedulerPolicy": "single-local-model-job",
            "scheduler": scheduler.status(),
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        })
    }

    pub fn recap_heuristic(
        &self,
        store: &RecordingStore,
        params: LocalRecapParams,
    ) -> Result<Value, LocalAiError> {
        let transcript = store.transcript(RecordingIdParams {
            recording_id: params.recording_id,
        })?;
        Ok(build_recap(transcript))
    }

    pub fn ask_heuristic(
        &self,
        store: &RecordingStore,
        params: LocalAskParams,
    ) -> Result<Value, LocalAiError> {
        let question = normalize_question(params.question)?;
        let transcript = store.transcript(RecordingIdParams {
            recording_id: params.recording_id,
        })?;
        Ok(build_ask(transcript, &question))
    }

    pub fn proof_heuristic_recap(
        &self,
        store: &RecordingStore,
        params: LocalAiProofParams,
    ) -> Result<Value, LocalAiError> {
        let (recording_id, finished) = seed_local_ai_proof_recording(
            store,
            params
                .label
                .unwrap_or_else(|| "local AI heuristic proof".to_string()),
        )?;
        let recap = self.recap_heuristic(
            store,
            LocalRecapParams {
                recording_id: recording_id.clone(),
            },
        )?;

        Ok(json!({
            "proof": {
                "synthetic": true,
                "engine": "heuristic-local",
                "localOnly": true,
                "cloudAi": false,
                "modelRequired": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "recording": finished,
            "recap": recap,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }

    pub fn proof_heuristic_ask(
        &self,
        store: &RecordingStore,
        params: LocalAiProofParams,
    ) -> Result<Value, LocalAiError> {
        let (recording_id, finished) = seed_local_ai_proof_recording(
            store,
            params
                .label
                .unwrap_or_else(|| "local AI heuristic ask proof".to_string()),
        )?;
        let ask = self.ask_heuristic(
            store,
            LocalAskParams {
                recording_id,
                question: "What action should Priya take?".to_string(),
            },
        )?;

        Ok(json!({
            "proof": {
                "synthetic": true,
                "engine": "heuristic-local",
                "askMode": "extractive-citations",
                "localOnly": true,
                "cloudAi": false,
                "modelRequired": false,
                "rawPathExposed": false,
                "keyMaterialExposedToRenderer": false
            },
            "recording": finished,
            "ask": ask,
            "rawPathExposed": false,
            "keyMaterialExposedToRenderer": false
        }))
    }
}

fn seed_local_ai_proof_recording(
    store: &RecordingStore,
    label: String,
) -> Result<(String, Value), LocalAiError> {
    let started = store.start(StartRecordingParams { label: Some(label) })?;
    let recording_id = started["recordingId"]
        .as_str()
        .ok_or_else(|| {
            LocalAiError::new(
                "LOCAL_AI_RECORDING_ID_MISSING",
                "recording start did not return an id",
            )
        })?
        .to_string();

    write_segment(
        store,
        &recording_id,
        "mic",
        "Alex",
        "Decision: ship the local recorder behind the M0 proof gate.",
        0,
    )?;
    write_segment(
        store,
        &recording_id,
        "system",
        "Priya",
        "Action: Priya to validate the network proof by Friday.",
        1_500,
    )?;
    write_segment(
        store,
        &recording_id,
        "system",
        "Lee",
        "Risk: system audio adapter may slip without PipeWire proof.",
        3_200,
    )?;
    write_segment(
        store,
        &recording_id,
        "mic",
        "Alex",
        "Question: do we need a fallback consent copy for Linux?",
        4_800,
    )?;

    let finished = store.finish(RecordingIdParams {
        recording_id: recording_id.clone(),
    })?;
    Ok((recording_id, finished))
}

fn write_segment(
    store: &RecordingStore,
    recording_id: &str,
    channel: &str,
    speaker: &str,
    text: &str,
    start_ms: u64,
) -> Result<(), LocalAiError> {
    store.write_transcript_segment(WriteTranscriptSegmentParams {
        recording_id: recording_id.to_string(),
        channel: channel.to_string(),
        speaker: Some(speaker.to_string()),
        text: text.to_string(),
        start_ms,
        duration_ms: Some(1_200),
        end_ms: None,
        confidence: Some(0.99),
    })?;
    Ok(())
}

fn build_recap(transcript: Value) -> Value {
    let segments = parse_segments(&transcript);
    let decisions = build_items(
        &segments,
        "decision",
        &[
            "decision", "decided", "agreed", "approved", "aligning", "we will",
        ],
    );
    let actions = build_items(
        &segments,
        "action",
        &[
            "action",
            "todo",
            "follow up",
            "follow-up",
            "please",
            " by ",
            " to ",
        ],
    );
    let risks = build_items(
        &segments,
        "risk",
        &[
            "risk", "blocked", "blocker", "slip", "delay", "degrade", "concern",
        ],
    );
    let questions = build_questions(&segments);
    let summary = build_summary(&segments, &decisions, &actions, &risks);
    let citations = build_citations(&decisions, &actions, &risks, &questions);
    let recap_markdown = build_markdown(&summary, &decisions, &actions, &risks, &questions);

    json!({
        "recordingId": transcript.get("recordingId").cloned().unwrap_or(Value::Null),
        "label": transcript.get("label").cloned().unwrap_or(Value::Null),
        "engine": "heuristic-local",
        "mode": "extractive",
        "localOnly": true,
        "cloudAi": false,
        "modelRequired": false,
        "segmentCount": segments.len(),
        "summary": summary,
        "decisions": decisions,
        "actions": actions,
        "risks": risks,
        "questions": questions,
        "citations": citations,
        "recapMarkdown": recap_markdown,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn build_ask(transcript: Value, question: &str) -> Value {
    let segments = parse_segments(&transcript);
    let intent = AskIntent::from_question(question);
    let (answer, citations) = match intent {
        AskIntent::Action => answer_from_items(
            "action items",
            build_items(
                &segments,
                "action",
                &[
                    "action",
                    "todo",
                    "follow up",
                    "follow-up",
                    "please",
                    " by ",
                    " to ",
                ],
            ),
        ),
        AskIntent::Decision => answer_from_items(
            "decisions",
            build_items(
                &segments,
                "decision",
                &[
                    "decision", "decided", "agreed", "approved", "aligning", "we will",
                ],
            ),
        ),
        AskIntent::Risk => answer_from_items(
            "risks",
            build_items(
                &segments,
                "risk",
                &[
                    "risk", "blocked", "blocker", "slip", "delay", "degrade", "concern",
                ],
            ),
        ),
        AskIntent::Question => answer_from_items("open questions", build_questions(&segments)),
        AskIntent::Summary => {
            let decisions = build_items(
                &segments,
                "decision",
                &[
                    "decision", "decided", "agreed", "approved", "aligning", "we will",
                ],
            );
            let actions = build_items(
                &segments,
                "action",
                &[
                    "action",
                    "todo",
                    "follow up",
                    "follow-up",
                    "please",
                    " by ",
                    " to ",
                ],
            );
            let risks = build_items(
                &segments,
                "risk",
                &[
                    "risk", "blocked", "blocker", "slip", "delay", "degrade", "concern",
                ],
            );
            let summary = build_summary(&segments, &decisions, &actions, &risks);
            let citations = build_citations(&decisions, &actions, &risks, &[]);
            (summary, citations)
        }
        AskIntent::General => answer_from_segments(&segments, question),
    };
    let answer_found = !citations.is_empty();

    json!({
        "recordingId": transcript.get("recordingId").cloned().unwrap_or(Value::Null),
        "label": transcript.get("label").cloned().unwrap_or(Value::Null),
        "question": question,
        "answer": answer,
        "answerFound": answer_found,
        "intent": intent.label(),
        "engine": "heuristic-local",
        "mode": "extractive-citations",
        "localOnly": true,
        "cloudAi": false,
        "modelRequired": false,
        "segmentCount": segments.len(),
        "matchedSegmentCount": citations.len(),
        "citations": citations,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn parse_segments(transcript: &Value) -> Vec<RecapSegment> {
    transcript
        .get("segments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|segment| {
            let text = collapse_spaces(segment.get("text").and_then(Value::as_str).unwrap_or(""));
            if text.is_empty() {
                return None;
            }
            let channel = segment
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("mixed")
                .to_string();
            let speaker = segment
                .get("speaker")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| if channel == "mic" { "Me" } else { "Speaker" })
                .to_string();
            Some(RecapSegment {
                index: segment
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                channel,
                speaker,
                text,
                start_ms: segment
                    .get("startMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            })
        })
        .collect()
}

#[derive(Copy, Clone, Debug)]
enum AskIntent {
    Action,
    Decision,
    Risk,
    Question,
    Summary,
    General,
}

impl AskIntent {
    fn from_question(question: &str) -> Self {
        let lower = question.to_ascii_lowercase();
        if contains_any(
            &lower,
            &["action", "todo", "follow up", "follow-up", "next step"],
        ) {
            Self::Action
        } else if contains_any(&lower, &["decision", "decided", "agree", "approved"]) {
            Self::Decision
        } else if contains_any(&lower, &["risk", "blocker", "blocked", "concern", "delay"]) {
            Self::Risk
        } else if contains_any(&lower, &["question", "unanswered", "open item"]) {
            Self::Question
        } else if contains_any(&lower, &["summary", "summarize", "recap", "what happened"]) {
            Self::Summary
        } else {
            Self::General
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Decision => "decision",
            Self::Risk => "risk",
            Self::Question => "question",
            Self::Summary => "summary",
            Self::General => "general",
        }
    }
}

fn answer_from_items(section_name: &str, items: Vec<Value>) -> (String, Vec<Value>) {
    if items.is_empty() {
        return (
            format!("I could not find {section_name} in this local transcript."),
            Vec::new(),
        );
    }

    let texts = items
        .iter()
        .take(3)
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let answer = format!(
        "Found {} {}: {}.",
        items.len(),
        section_name,
        texts.join("; ")
    );
    let citations = items
        .iter()
        .take(MAX_ASK_CITATIONS)
        .map(citation_from_item)
        .collect::<Vec<_>>();
    (answer, citations)
}

fn answer_from_segments(segments: &[RecapSegment], question: &str) -> (String, Vec<Value>) {
    let terms = question_terms(question);
    let mut scored = segments
        .iter()
        .filter_map(|segment| {
            let score = score_segment(segment, &terms);
            if score == 0 {
                None
            } else {
                Some((score, segment))
            }
        })
        .collect::<Vec<_>>();
    scored.sort_by_key(|(score, segment)| (std::cmp::Reverse(*score), segment.start_ms));

    if scored.is_empty() {
        return (
            "I could not find an answer in this local transcript.".to_string(),
            Vec::new(),
        );
    }

    let answer_parts = scored
        .iter()
        .take(3)
        .map(|(_, segment)| sentence_head(&strip_known_prefixes(&segment.text)))
        .collect::<Vec<_>>();
    let citations = scored
        .iter()
        .take(MAX_ASK_CITATIONS)
        .map(|(score, segment)| citation_from_segment(segment, Some(*score)))
        .collect::<Vec<_>>();
    (
        format!("The transcript points to: {}.", answer_parts.join(" ")),
        citations,
    )
}

fn citation_from_item(item: &Value) -> Value {
    json!({
        "segmentIndex": item.get("segmentIndex").cloned().unwrap_or(Value::Null),
        "startMs": item.get("startMs").cloned().unwrap_or(Value::Null),
        "speaker": item.get("speaker").cloned().unwrap_or(Value::Null),
        "channel": item.get("channel").cloned().unwrap_or(Value::Null),
        "quote": item.get("quote").cloned().unwrap_or(Value::Null),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn citation_from_segment(segment: &RecapSegment, score: Option<u32>) -> Value {
    json!({
        "segmentIndex": segment.index,
        "startMs": segment.start_ms,
        "speaker": segment.speaker,
        "channel": segment.channel,
        "quote": trim_to(&segment.text, MAX_QUOTE_CHARS),
        "score": score,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn build_items(segments: &[RecapSegment], category: &str, keywords: &[&str]) -> Vec<Value> {
    let mut items = Vec::new();
    for segment in segments {
        let lower = segment.text.to_ascii_lowercase();
        if !keywords.iter().any(|keyword| lower.contains(keyword)) {
            continue;
        }
        items.push(item_value(category, segment));
        if items.len() >= MAX_ITEMS_PER_SECTION {
            break;
        }
    }
    items
}

fn build_questions(segments: &[RecapSegment]) -> Vec<Value> {
    let mut items = Vec::new();
    for segment in segments {
        let lower = segment.text.to_ascii_lowercase();
        if !segment.text.contains('?') && !lower.contains("question") {
            continue;
        }
        items.push(item_value("question", segment));
        if items.len() >= MAX_ITEMS_PER_SECTION {
            break;
        }
    }
    items
}

fn item_value(category: &str, segment: &RecapSegment) -> Value {
    let text = sentence_head(&strip_known_prefixes(&segment.text));
    json!({
        "category": category,
        "text": text,
        "speaker": segment.speaker,
        "channel": segment.channel,
        "startMs": segment.start_ms,
        "segmentIndex": segment.index,
        "quote": trim_to(&segment.text, MAX_QUOTE_CHARS),
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn build_summary(
    segments: &[RecapSegment],
    decisions: &[Value],
    actions: &[Value],
    risks: &[Value],
) -> String {
    let mut parts = Vec::new();
    for item in decisions.iter().take(2).chain(actions.iter().take(1)) {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            parts.push(text.to_string());
        }
    }
    if parts.is_empty() {
        for segment in segments.iter().take(3) {
            parts.push(sentence_head(&strip_known_prefixes(&segment.text)));
        }
    }
    if let Some(risk) = risks
        .first()
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
    {
        parts.push(format!("Primary risk: {risk}"));
    }
    if parts.is_empty() {
        "No transcript text is available yet.".to_string()
    } else {
        trim_to(&parts.join(" "), 420)
    }
}

fn build_citations(
    decisions: &[Value],
    actions: &[Value],
    risks: &[Value],
    questions: &[Value],
) -> Vec<Value> {
    let mut seen = Vec::<u64>::new();
    let mut citations = Vec::<Value>::new();
    for item in decisions
        .iter()
        .chain(actions.iter())
        .chain(risks.iter())
        .chain(questions.iter())
    {
        let index = item
            .get("segmentIndex")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if seen.contains(&index) {
            continue;
        }
        seen.push(index);
        citations.push(json!({
            "segmentIndex": index,
            "startMs": item.get("startMs").cloned().unwrap_or(Value::Null),
            "speaker": item.get("speaker").cloned().unwrap_or(Value::Null),
            "quote": item.get("quote").cloned().unwrap_or(Value::Null),
            "rawPathExposed": false
        }));
        if citations.len() >= 8 {
            break;
        }
    }
    citations
}

fn build_markdown(
    summary: &str,
    decisions: &[Value],
    actions: &[Value],
    risks: &[Value],
    questions: &[Value],
) -> String {
    let mut markdown = String::new();
    markdown.push_str("## Local AI Recap\n\n");
    markdown.push_str(summary);
    markdown.push_str("\n\n");
    append_section(&mut markdown, "Decisions", decisions);
    append_section(&mut markdown, "Actions", actions);
    append_section(&mut markdown, "Risks", risks);
    append_section(&mut markdown, "Questions", questions);
    markdown
}

fn append_section(markdown: &mut String, title: &str, items: &[Value]) {
    markdown.push_str("### ");
    markdown.push_str(title);
    markdown.push_str("\n\n");
    if items.is_empty() {
        markdown.push_str("- None found locally.\n\n");
        return;
    }
    for item in items {
        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
        let speaker = item
            .get("speaker")
            .and_then(Value::as_str)
            .unwrap_or("Speaker");
        let start_ms = item
            .get("startMs")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        markdown.push_str(&format!("- `{start_ms} ms` **{speaker}:** {text}\n"));
    }
    markdown.push('\n');
}

fn strip_known_prefixes(text: &str) -> String {
    let mut cleaned = collapse_spaces(text);
    for prefix in ["Decision:", "Action:", "Risk:", "Question:", "Todo:"] {
        if cleaned
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
        {
            cleaned = cleaned[prefix.len()..].trim_start().to_string();
        }
    }
    cleaned
}

fn sentence_head(text: &str) -> String {
    let cleaned = collapse_spaces(text);
    for (index, character) in cleaned.char_indices() {
        if matches!(character, '.' | '?' | '!') {
            return trim_to(&cleaned[..=index], MAX_QUOTE_CHARS);
        }
    }
    trim_to(&cleaned, MAX_QUOTE_CHARS)
}

fn normalize_question(question: String) -> Result<String, LocalAiError> {
    let cleaned = collapse_spaces(&question);
    if cleaned.is_empty() {
        return Err(LocalAiError::new(
            "LOCAL_AI_QUESTION_INVALID",
            "question must not be empty",
        ));
    }
    if cleaned.len() > MAX_QUESTION_BYTES {
        return Err(LocalAiError::new(
            "LOCAL_AI_QUESTION_INVALID",
            format!("question exceeds {MAX_QUESTION_BYTES} byte limit"),
        ));
    }
    Ok(cleaned)
}

fn question_terms(question: &str) -> Vec<String> {
    let mut terms = Vec::<String>::new();
    for token in question
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
    {
        if token.len() < 3 || is_stopword(token) || terms.iter().any(|value| value == token) {
            continue;
        }
        terms.push(token.to_string());
    }
    terms
}

fn score_segment(segment: &RecapSegment, terms: &[String]) -> u32 {
    let lower_text = segment.text.to_ascii_lowercase();
    let lower_speaker = segment.speaker.to_ascii_lowercase();
    let mut score = 0_u32;
    for term in terms {
        if lower_text.contains(term) {
            score = score.saturating_add(3);
        }
        if lower_speaker.contains(term) {
            score = score.saturating_add(2);
        }
    }
    score
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "about"
            | "after"
            | "again"
            | "also"
            | "and"
            | "are"
            | "can"
            | "did"
            | "does"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "how"
            | "into"
            | "our"
            | "should"
            | "that"
            | "the"
            | "their"
            | "this"
            | "was"
            | "were"
            | "what"
            | "when"
            | "where"
            | "who"
            | "why"
            | "will"
            | "with"
    )
}

fn collapse_spaces(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn trim_to(text: &str, max_chars: usize) -> String {
    let cleaned = collapse_spaces(text);
    if cleaned.chars().count() <= max_chars {
        return cleaned;
    }
    let keep = max_chars.saturating_sub(3);
    let mut output = cleaned.chars().take(keep).collect::<String>();
    output.push_str("...");
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_store::RecordingStore;
    use std::process;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn store() -> RecordingStore {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root =
            std::env::temp_dir().join(format!("candor-local-ai-test-{}-{stamp}", process::id()));
        RecordingStore::with_root(root)
    }

    #[test]
    fn heuristic_recap_extracts_local_sections() {
        let store = store();
        let service = LocalAiService;
        let proof = service
            .proof_heuristic_recap(&store, LocalAiProofParams::default())
            .expect("proof heuristic recap");
        let recap = &proof["recap"];

        assert_eq!(recap["engine"], "heuristic-local");
        assert_eq!(recap["localOnly"], true);
        assert_eq!(recap["cloudAi"], false);
        assert_eq!(recap["modelRequired"], false);
        assert_eq!(recap["rawPathExposed"], false);
        assert_eq!(recap["decisions"].as_array().unwrap().len(), 1);
        assert_eq!(recap["actions"].as_array().unwrap().len(), 1);
        assert_eq!(recap["risks"].as_array().unwrap().len(), 1);
        assert_eq!(recap["questions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn heuristic_ask_answers_from_local_citations() {
        let store = store();
        let service = LocalAiService;
        let proof = service
            .proof_heuristic_ask(&store, LocalAiProofParams::default())
            .expect("proof heuristic ask");
        let ask = &proof["ask"];

        assert_eq!(ask["engine"], "heuristic-local");
        assert_eq!(ask["mode"], "extractive-citations");
        assert_eq!(ask["localOnly"], true);
        assert_eq!(ask["cloudAi"], false);
        assert_eq!(ask["modelRequired"], false);
        assert_eq!(ask["answerFound"], true);
        assert_eq!(ask["rawPathExposed"], false);
        assert!(!ask["citations"].as_array().unwrap().is_empty());
    }
}
