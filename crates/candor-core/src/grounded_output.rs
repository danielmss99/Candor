use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{json, Value};

const OUTPUT_SCHEMA_VERSION: u32 = 1;
const MAX_ITEMS_PER_SECTION: usize = 24;
const MAX_TOTAL_CLAIMS: usize = 80;
const MAX_CLAIM_CHARS: usize = 1_000;
const MAX_SOURCE_IDS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroundedMode {
    Recap,
    Ask,
}

#[derive(Clone, Debug)]
pub struct GroundingSource {
    pub citation_id: String,
    pub segment_index: u64,
    pub channel: String,
    pub speaker: String,
    pub text: String,
    pub start_ms: u64,
}

#[derive(Debug)]
pub struct GroundedOutputError {
    pub code: &'static str,
    pub message: String,
}

impl GroundedOutputError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug)]
pub struct GroundedResult {
    pub output: String,
    pub summary: String,
    pub decisions: Vec<Value>,
    pub actions: Vec<Value>,
    pub risks: Vec<Value>,
    pub questions: Vec<Value>,
    pub answer: String,
    pub answer_found: bool,
    pub citations: Vec<Value>,
    pub source_ids: Vec<String>,
    pub summary_source_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundedOutputV1 {
    schema_version: u32,
    summary: Vec<GroundedClaim>,
    decisions: Vec<GroundedClaim>,
    actions: Vec<GroundedAction>,
    risks: Vec<GroundedClaim>,
    questions: Vec<GroundedClaim>,
    answer: Option<GroundedClaim>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundedClaim {
    text: String,
    source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GroundedAction {
    text: String,
    owner: Option<String>,
    due_date: Option<String>,
    confidence: ClaimConfidence,
    source_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ClaimConfidence {
    High,
    Medium,
    Low,
}

impl ClaimConfidence {
    fn id(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

pub fn validate_and_render(
    raw_output: &str,
    sources: &[GroundingSource],
    mode: GroundedMode,
    glossary: Option<&str>,
) -> Result<GroundedResult, GroundedOutputError> {
    let parsed = serde_json::from_str::<GroundedOutputV1>(raw_output).map_err(|_| {
        GroundedOutputError::new(
            "LOCAL_LLM_OUTPUT_JSON_INVALID",
            "the local model did not return the required JSON object",
        )
    })?;
    if parsed.schema_version != OUTPUT_SCHEMA_VERSION {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_OUTPUT_SCHEMA_MISMATCH",
            "the local model returned an unsupported output schema",
        ));
    }
    validate_section_limits(&parsed)?;
    match mode {
        GroundedMode::Recap if parsed.answer.is_some() => {
            return Err(GroundedOutputError::new(
                "LOCAL_LLM_OUTPUT_MODE_INVALID",
                "a recap response must set answer to null",
            ));
        }
        GroundedMode::Ask
            if !parsed.summary.is_empty()
                || !parsed.decisions.is_empty()
                || !parsed.actions.is_empty()
                || !parsed.risks.is_empty()
                || !parsed.questions.is_empty() =>
        {
            return Err(GroundedOutputError::new(
                "LOCAL_LLM_OUTPUT_MODE_INVALID",
                "an Ask response must leave recap sections empty",
            ));
        }
        _ => {}
    }

    let glossary_terms = glossary_terms(glossary);
    for claim in parsed
        .summary
        .iter()
        .chain(parsed.decisions.iter())
        .chain(parsed.risks.iter())
        .chain(parsed.questions.iter())
        .chain(parsed.answer.iter())
    {
        validate_claim(claim, sources, &glossary_terms)?;
    }
    for action in &parsed.actions {
        let claim = GroundedClaim {
            text: action.text.clone(),
            source_ids: action.source_ids.clone(),
        };
        validate_claim(&claim, sources, &glossary_terms)?;
        validate_action_metadata(action, sources)?;
    }

    let decisions = parsed
        .decisions
        .iter()
        .map(|claim| claim_value("decision", claim, sources, None, None, None))
        .collect::<Result<Vec<_>, _>>()?;
    let actions = parsed
        .actions
        .iter()
        .map(|action| {
            let claim = GroundedClaim {
                text: action.text.clone(),
                source_ids: action.source_ids.clone(),
            };
            claim_value(
                "action",
                &claim,
                sources,
                action.owner.as_deref(),
                action.due_date.as_deref(),
                Some(action.confidence),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let risks = parsed
        .risks
        .iter()
        .map(|claim| claim_value("risk", claim, sources, None, None, None))
        .collect::<Result<Vec<_>, _>>()?;
    let questions = parsed
        .questions
        .iter()
        .map(|claim| claim_value("question", claim, sources, None, None, None))
        .collect::<Result<Vec<_>, _>>()?;
    let summary = parsed
        .summary
        .iter()
        .map(|claim| normalize_text(&claim.text))
        .collect::<Vec<_>>()
        .join(" ");
    let source_ids = source_ids_for_mode(&parsed, mode);
    let summary_source_ids =
        unique_source_ids(parsed.summary.iter().map(|claim| &claim.source_ids));
    let citations = source_ids
        .iter()
        .filter_map(|source_id| {
            sources
                .iter()
                .find(|source| &source.citation_id == source_id)
        })
        .map(citation_value)
        .collect::<Vec<_>>();
    let answer_found = parsed.answer.is_some();
    let answer = parsed
        .answer
        .as_ref()
        .map(render_claim)
        .unwrap_or_else(|| "No grounded answer was found in this meeting.".to_string());
    let output = match mode {
        GroundedMode::Recap => render_recap(&parsed),
        GroundedMode::Ask => answer.clone(),
    };

    Ok(GroundedResult {
        output,
        summary,
        decisions,
        actions,
        risks,
        questions,
        answer,
        answer_found,
        citations,
        source_ids,
        summary_source_ids,
    })
}

fn validate_section_limits(output: &GroundedOutputV1) -> Result<(), GroundedOutputError> {
    let lengths = [
        output.summary.len(),
        output.decisions.len(),
        output.actions.len(),
        output.risks.len(),
        output.questions.len(),
    ];
    if lengths.iter().any(|length| *length > MAX_ITEMS_PER_SECTION)
        || lengths.iter().sum::<usize>() + usize::from(output.answer.is_some()) > MAX_TOTAL_CLAIMS
    {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_OUTPUT_LIMIT_EXCEEDED",
            "the local model returned too many structured claims",
        ));
    }
    Ok(())
}

fn validate_claim(
    claim: &GroundedClaim,
    sources: &[GroundingSource],
    glossary_terms: &[String],
) -> Result<(), GroundedOutputError> {
    let text = normalize_text(&claim.text);
    if text.is_empty()
        || text.chars().count() > MAX_CLAIM_CHARS
        || text.chars().any(char::is_control)
        || text.contains("[s")
    {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_CLAIM_INVALID",
            "a local model claim was empty, oversized, or contained embedded citations",
        ));
    }
    let cited = cited_sources(&claim.source_ids, sources)?;
    let evidence = cited
        .iter()
        .map(|source| source.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    validate_exact_numbers(&text, &evidence)?;
    validate_exact_sensitive_terms(&text, &evidence, glossary_terms)?;
    if !lexically_grounded(&text, &evidence) {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_CLAIM_UNGROUNDED",
            "a local model claim was not supported by its cited transcript segments",
        ));
    }
    Ok(())
}

fn validate_action_metadata(
    action: &GroundedAction,
    sources: &[GroundingSource],
) -> Result<(), GroundedOutputError> {
    let cited = cited_sources(&action.source_ids, sources)?;
    if let Some(owner) = action.owner.as_deref() {
        let owner = validate_metadata_text(owner, "LOCAL_LLM_OWNER_INVALID")?;
        let supported = cited.iter().any(|source| {
            contains_phrase(&source.text, &owner) || contains_phrase(&source.speaker, &owner)
        });
        if !supported {
            return Err(GroundedOutputError::new(
                "LOCAL_LLM_OWNER_UNSUPPORTED",
                "an action owner was not stated by the cited transcript evidence",
            ));
        }
    }
    if let Some(due_date) = action.due_date.as_deref() {
        let due_date = validate_metadata_text(due_date, "LOCAL_LLM_DUE_DATE_INVALID")?;
        if !cited
            .iter()
            .any(|source| contains_phrase(&source.text, &due_date))
        {
            return Err(GroundedOutputError::new(
                "LOCAL_LLM_DUE_DATE_UNSUPPORTED",
                "an action due date was not stated by the cited transcript evidence",
            ));
        }
    }
    Ok(())
}

fn validate_metadata_text(value: &str, code: &'static str) -> Result<String, GroundedOutputError> {
    let value = normalize_text(value);
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        Err(GroundedOutputError::new(
            code,
            "structured action metadata is invalid",
        ))
    } else {
        Ok(value)
    }
}

fn cited_sources<'a>(
    source_ids: &[String],
    sources: &'a [GroundingSource],
) -> Result<Vec<&'a GroundingSource>, GroundedOutputError> {
    if source_ids.is_empty() || source_ids.len() > MAX_SOURCE_IDS {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_SOURCE_IDS_INVALID",
            "every local model claim needs one to four source IDs",
        ));
    }
    let mut seen = HashSet::new();
    let mut cited = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        if !seen.insert(source_id) {
            return Err(GroundedOutputError::new(
                "LOCAL_LLM_SOURCE_IDS_INVALID",
                "a local model claim repeated a source ID",
            ));
        }
        let source = sources
            .iter()
            .find(|source| source.citation_id == *source_id)
            .ok_or_else(|| {
                GroundedOutputError::new(
                    "LOCAL_LLM_SOURCE_ID_UNKNOWN",
                    "a local model claim cited an unknown transcript source",
                )
            })?;
        cited.push(source);
    }
    Ok(cited)
}

fn lexically_grounded(claim: &str, evidence: &str) -> bool {
    let claim_tokens = meaningful_tokens(claim);
    if claim_tokens.is_empty() {
        return false;
    }
    if claim_tokens.len() == 1 {
        return evidence.to_lowercase().contains(&claim_tokens[0]);
    }
    let evidence_tokens = meaningful_tokens(evidence)
        .into_iter()
        .collect::<HashSet<_>>();
    let overlap = claim_tokens
        .iter()
        .filter(|token| evidence_tokens.contains(*token))
        .count();
    let required = match claim_tokens.len() {
        0..=3 => claim_tokens.len(),
        4..=7 => 3,
        _ => 3,
    };
    overlap >= required
}

fn validate_exact_numbers(claim: &str, evidence: &str) -> Result<(), GroundedOutputError> {
    let evidence_numbers = numeric_tokens(evidence).into_iter().collect::<HashSet<_>>();
    if numeric_tokens(claim)
        .into_iter()
        .any(|number| !evidence_numbers.contains(&number))
    {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_NUMERIC_CLAIM_UNSUPPORTED",
            "a number or dosage in a local model claim did not match its cited evidence",
        ));
    }
    Ok(())
}

fn validate_exact_sensitive_terms(
    claim: &str,
    evidence: &str,
    glossary_terms: &[String],
) -> Result<(), GroundedOutputError> {
    let claim_lower = claim.to_lowercase();
    let evidence_lower = evidence.to_lowercase();
    if glossary_terms
        .iter()
        .any(|term| claim_lower.contains(term.as_str()) && !evidence_lower.contains(term.as_str()))
    {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_TERMINOLOGY_CLAIM_UNSUPPORTED",
            "a specialist term in a local model claim was not present in its cited evidence",
        ));
    }
    let evidence_words = words(evidence).into_iter().collect::<HashSet<_>>();
    if words(claim)
        .into_iter()
        .filter(|word| is_sensitive_word(word))
        .any(|word| !evidence_words.contains(&word))
    {
        return Err(GroundedOutputError::new(
            "LOCAL_LLM_CRITICAL_CLAIM_UNSUPPORTED",
            "a drug or dosage term in a local model claim did not match its cited evidence",
        ));
    }
    Ok(())
}

fn is_sensitive_word(word: &str) -> bool {
    const DOSAGE_UNITS: &[&str] = &[
        "mg", "mcg", "ug", "g", "kg", "ml", "l", "mmol", "mol", "iu", "units", "percent",
    ];
    const DRUG_SUFFIXES: &[&str] = &[
        "mab",
        "nib",
        "vir",
        "cillin",
        "mycin",
        "olol",
        "prazole",
        "statin",
        "xaban",
        "gliflozin",
        "gliptin",
    ];
    DOSAGE_UNITS.contains(&word)
        || (word.len() >= 6 && DRUG_SUFFIXES.iter().any(|suffix| word.ends_with(suffix)))
}

fn source_ids_for_mode(output: &GroundedOutputV1, mode: GroundedMode) -> Vec<String> {
    let source_lists: Vec<&Vec<String>> = match mode {
        GroundedMode::Recap => output
            .summary
            .iter()
            .map(|claim| &claim.source_ids)
            .chain(output.decisions.iter().map(|claim| &claim.source_ids))
            .chain(output.actions.iter().map(|claim| &claim.source_ids))
            .chain(output.risks.iter().map(|claim| &claim.source_ids))
            .chain(output.questions.iter().map(|claim| &claim.source_ids))
            .collect(),
        GroundedMode::Ask => output
            .answer
            .iter()
            .map(|claim| &claim.source_ids)
            .collect(),
    };
    unique_source_ids(source_lists)
}

fn unique_source_ids<'a>(source_lists: impl IntoIterator<Item = &'a Vec<String>>) -> Vec<String> {
    let mut ids = Vec::new();
    for source_id in source_lists.into_iter().flatten() {
        if !ids.contains(source_id) {
            ids.push(source_id.clone());
        }
    }
    ids
}

fn claim_value(
    category: &str,
    claim: &GroundedClaim,
    sources: &[GroundingSource],
    owner: Option<&str>,
    due_date: Option<&str>,
    confidence: Option<ClaimConfidence>,
) -> Result<Value, GroundedOutputError> {
    let cited = cited_sources(&claim.source_ids, sources)?;
    let source = cited[0];
    let mut speakers = Vec::new();
    let mut channels = Vec::new();
    for cited_source in &cited {
        if !speakers.contains(&cited_source.speaker) {
            speakers.push(cited_source.speaker.clone());
        }
        if !channels.contains(&cited_source.channel) {
            channels.push(cited_source.channel.clone());
        }
    }
    let speaker = if speakers.len() == 1 {
        source.speaker.clone()
    } else {
        "Multiple speakers".to_string()
    };
    let channel = if channels.len() == 1 {
        source.channel.clone()
    } else {
        "mixed".to_string()
    };
    let start_ms = cited
        .iter()
        .map(|source| source.start_ms)
        .min()
        .unwrap_or(source.start_ms);
    Ok(json!({
        "category": category,
        "text": normalize_text(&claim.text),
        "owner": owner.map(normalize_text),
        "dueDate": due_date.map(normalize_text),
        "confidence": confidence.map(ClaimConfidence::id),
        "sourceIds": claim.source_ids,
        "speaker": speaker,
        "speakers": speakers,
        "channel": channel,
        "startMs": start_ms,
        "segmentIndex": source.segment_index,
        "quote": source.text,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    }))
}

fn citation_value(source: &GroundingSource) -> Value {
    json!({
        "citationId": source.citation_id,
        "segmentIndex": source.segment_index,
        "startMs": source.start_ms,
        "speaker": source.speaker,
        "channel": source.channel,
        "quote": source.text,
        "rawPathExposed": false,
        "keyMaterialExposedToRenderer": false
    })
}

fn render_recap(output: &GroundedOutputV1) -> String {
    let mut markdown = String::new();
    append_section(
        &mut markdown,
        "Summary",
        output.summary.iter().map(render_claim),
    );
    append_section(
        &mut markdown,
        "Decisions",
        output.decisions.iter().map(render_claim),
    );
    append_section(
        &mut markdown,
        "Actions",
        output.actions.iter().map(|action| {
            render_claim(&GroundedClaim {
                text: action.text.clone(),
                source_ids: action.source_ids.clone(),
            })
        }),
    );
    append_section(
        &mut markdown,
        "Risks",
        output.risks.iter().map(render_claim),
    );
    append_section(
        &mut markdown,
        "Questions",
        output.questions.iter().map(render_claim),
    );
    markdown.trim().to_string()
}

fn append_section<I>(markdown: &mut String, heading: &str, claims: I)
where
    I: IntoIterator<Item = String>,
{
    markdown.push_str("## ");
    markdown.push_str(heading);
    markdown.push('\n');
    let claims = claims.into_iter().collect::<Vec<_>>();
    if claims.is_empty() {
        markdown.push_str("- None\n\n");
    } else {
        for claim in claims {
            markdown.push_str("- ");
            markdown.push_str(&claim);
            markdown.push('\n');
        }
        markdown.push('\n');
    }
}

fn render_claim(claim: &GroundedClaim) -> String {
    let citations = claim
        .source_ids
        .iter()
        .map(|source_id| format!("[{source_id}]"))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{} {citations}", normalize_text(&claim.text))
}

fn glossary_terms(glossary: Option<&str>) -> Vec<String> {
    glossary
        .into_iter()
        .flat_map(str::lines)
        .filter_map(|line| line.trim().strip_prefix("- "))
        .map(|line| line.split(':').next().unwrap_or(line).trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect()
}

fn numeric_tokens(text: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_ascii_digit() || (!current.is_empty() && matches!(character, '.' | ',')) {
            current.push(character);
        } else if !current.is_empty() {
            output.push(current.trim_end_matches([',', '.']).to_string());
            current.clear();
        }
    }
    if !current.is_empty() {
        output.push(current.trim_end_matches([',', '.']).to_string());
    }
    output.retain(|value| !value.is_empty());
    output
}

fn meaningful_tokens(text: &str) -> Vec<String> {
    words(text)
        .into_iter()
        .filter(|token| token.len() >= 3 && !is_stopword(token))
        .collect()
}

fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|word| !word.is_empty())
        .collect()
}

fn is_stopword(token: &str) -> bool {
    matches!(
        token,
        "the"
            | "and"
            | "for"
            | "with"
            | "from"
            | "that"
            | "this"
            | "will"
            | "must"
            | "after"
            | "before"
            | "into"
            | "only"
            | "each"
            | "every"
            | "under"
            | "was"
            | "were"
            | "are"
            | "has"
            | "have"
            | "had"
            | "not"
            | "but"
            | "about"
    )
}

fn contains_phrase(text: &str, phrase: &str) -> bool {
    text.to_lowercase().contains(&phrase.to_lowercase())
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> Vec<GroundingSource> {
        vec![
            GroundingSource {
                citation_id: "s0".to_string(),
                segment_index: 0,
                channel: "system".to_string(),
                speaker: "Priya".to_string(),
                text: "Priya will review adalimumab 20 mg dosing by Friday.".to_string(),
                start_ms: 10,
            },
            GroundingSource {
                citation_id: "s1".to_string(),
                segment_index: 1,
                channel: "mic".to_string(),
                speaker: "Alex".to_string(),
                text: "The release remains blocked until the offline test passes.".to_string(),
                start_ms: 20,
            },
        ]
    }

    fn recap(action: &str) -> String {
        format!(
            "{{\"schemaVersion\":1,\"summary\":[{{\"text\":\"The release remains blocked until offline testing passes.\",\"sourceIds\":[\"s1\"]}}],\"decisions\":[],\"actions\":[{action}],\"risks\":[],\"questions\":[],\"answer\":null}}"
        )
    }

    #[test]
    fn validates_grounded_pharmaceutical_recap_and_renders_compatibility_fields() {
        let output = recap("{\"text\":\"Priya reviews adalimumab 20 mg dosing by Friday.\",\"owner\":\"Priya\",\"dueDate\":\"Friday\",\"confidence\":\"high\",\"sourceIds\":[\"s0\"]}");
        let result = validate_and_render(
            &output,
            &sources(),
            GroundedMode::Recap,
            Some("- adalimumab: monoclonal antibody\n"),
        )
        .expect("grounded output");
        assert!(result.output.contains("adalimumab 20 mg"));
        assert_eq!(result.actions.len(), 1);
        assert_eq!(result.citations.len(), 2);
        assert_eq!(result.summary_source_ids, vec!["s1"]);
    }

    #[test]
    fn rejects_unknown_sources_and_uncited_claims() {
        let unknown = recap("{\"text\":\"Priya reviews dosing.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s9\"]}");
        assert_eq!(
            validate_and_render(&unknown, &sources(), GroundedMode::Recap, None)
                .expect_err("unknown source")
                .code,
            "LOCAL_LLM_SOURCE_ID_UNKNOWN"
        );
        let uncited = recap(
            "{\"text\":\"Priya reviews dosing.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[]}",
        );
        assert_eq!(
            validate_and_render(&uncited, &sources(), GroundedMode::Recap, None)
                .expect_err("uncited claim")
                .code,
            "LOCAL_LLM_SOURCE_IDS_INVALID"
        );
    }

    #[test]
    fn rejects_mutated_dosages_drugs_owners_and_dates() {
        for (action, expected) in [
            ("{\"text\":\"Priya reviews adalimumab 25 mg dosing.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s0\"]}", "LOCAL_LLM_NUMERIC_CLAIM_UNSUPPORTED"),
            ("{\"text\":\"Priya reviews pembrolizumab 20 mg dosing.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s0\"]}", "LOCAL_LLM_CRITICAL_CLAIM_UNSUPPORTED"),
            ("{\"text\":\"Priya will review dosing.\",\"owner\":\"Morgan\",\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s0\"]}", "LOCAL_LLM_OWNER_UNSUPPORTED"),
            ("{\"text\":\"Priya will review dosing.\",\"owner\":null,\"dueDate\":\"Monday\",\"confidence\":\"medium\",\"sourceIds\":[\"s0\"]}", "LOCAL_LLM_DUE_DATE_UNSUPPORTED"),
        ] {
            assert_eq!(
                validate_and_render(&recap(action), &sources(), GroundedMode::Recap, None)
                    .expect_err("unsupported critical fact")
                    .code,
                expected
            );
        }
    }

    #[test]
    fn rejects_short_claim_with_only_two_matching_terms() {
        let output = recap("{\"text\":\"Release blocked invents cloud approval.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s1\"]}");
        assert_eq!(
            validate_and_render(&output, &sources(), GroundedMode::Recap, None)
                .expect_err("half-divergent claim")
                .code,
            "LOCAL_LLM_CLAIM_UNGROUNDED"
        );
    }

    #[test]
    fn multi_source_claims_report_all_speakers_and_mixed_channel() {
        let output = recap("{\"text\":\"Priya reviews release offline.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s0\",\"s1\"]}");
        let result = validate_and_render(&output, &sources(), GroundedMode::Recap, None)
            .expect("multi-source claim");
        assert_eq!(result.actions[0]["speaker"], "Multiple speakers");
        assert_eq!(result.actions[0]["speakers"], json!(["Priya", "Alex"]));
        assert_eq!(result.actions[0]["channel"], "mixed");
        assert_eq!(result.actions[0]["startMs"], 10);
    }

    #[test]
    fn ask_allows_an_explicit_unsupported_answer_without_inventing_content() {
        let output = "{\"schemaVersion\":1,\"summary\":[],\"decisions\":[],\"actions\":[],\"risks\":[],\"questions\":[],\"answer\":null}";
        let result = validate_and_render(output, &sources(), GroundedMode::Ask, None)
            .expect("empty grounded answer");
        assert!(!result.answer_found);
        assert!(result.citations.is_empty());
        assert!(result.answer.contains("No grounded answer"));
    }

    #[test]
    fn rejects_extra_fields_and_wrong_mode_payloads() {
        let extra = "{\"schemaVersion\":1,\"summary\":[],\"decisions\":[],\"actions\":[],\"risks\":[],\"questions\":[],\"answer\":null,\"reasoning\":\"hidden\"}";
        assert_eq!(
            validate_and_render(extra, &sources(), GroundedMode::Ask, None)
                .expect_err("extra field")
                .code,
            "LOCAL_LLM_OUTPUT_JSON_INVALID"
        );
        let wrong_mode = recap("{\"text\":\"Priya reviews dosing.\",\"owner\":null,\"dueDate\":null,\"confidence\":\"medium\",\"sourceIds\":[\"s0\"]}");
        assert_eq!(
            validate_and_render(&wrong_mode, &sources(), GroundedMode::Ask, None)
                .expect_err("wrong mode")
                .code,
            "LOCAL_LLM_OUTPUT_MODE_INVALID"
        );
    }
}
