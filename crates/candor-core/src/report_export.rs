use std::io::{Cursor, Write};

use krilla::color::rgb;
use krilla::destination::XyzDestination;
use krilla::geom::Point;
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::outline::{Outline, OutlineNode};
use krilla::page::PageSettings;
use krilla::paint::Fill;
use krilla::text::{Font, TextDirection};
use krilla::Document;
use pulldown_cmark::{Event, HeadingLevel, Options as MarkdownOptions, Parser, Tag, TagEnd};
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event as XmlEvent};
use quick_xml::Writer;
use rustybuzz::{Face, UnicodeBuffer};
use serde::Deserialize;
use time::OffsetDateTime;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

const NOTO_SANS_REGULAR: &[u8] = include_bytes!("../assets/fonts/NotoSans-Regular.ttf");
const NOTO_SANS_BOLD: &[u8] = include_bytes!("../assets/fonts/NotoSans-Bold.ttf");
const MAX_REPORT_SUMMARY_BYTES: usize = 128 * 1024;
const MAX_REPORT_ITEM_BYTES: usize = 8 * 1024;
const MAX_REPORT_ITEMS: usize = 500;
const MAX_NOTES_BYTES: usize = 512 * 1024;
const MAX_TRANSCRIPT_SEGMENTS: usize = 10_000;
const MAX_TRANSCRIPT_TEXT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportReportInput {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub decisions: Vec<ExportReportItemInput>,
    #[serde(default)]
    pub actions: Vec<ExportReportItemInput>,
    #[serde(default)]
    pub risks: Vec<ExportReportItemInput>,
    #[serde(default)]
    pub questions: Vec<ExportReportItemInput>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportReportItemInput {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub speaker: String,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub due_date: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportDocumentOptions {
    #[serde(default = "default_true")]
    pub include_summary: bool,
    #[serde(default = "default_true")]
    pub include_decisions: bool,
    #[serde(default = "default_true")]
    pub include_actions: bool,
    #[serde(default = "default_true")]
    pub include_risks: bool,
    #[serde(default = "default_true")]
    pub include_questions: bool,
    #[serde(default = "default_true")]
    pub include_notes: bool,
    #[serde(default = "default_true")]
    pub include_transcript: bool,
    #[serde(default = "default_true")]
    pub include_timestamps: bool,
    #[serde(default)]
    pub paper_size: PaperSize,
}

impl Default for ExportDocumentOptions {
    fn default() -> Self {
        Self {
            include_summary: true,
            include_decisions: true,
            include_actions: true,
            include_risks: true,
            include_questions: true,
            include_notes: true,
            include_transcript: true,
            include_timestamps: true,
            paper_size: PaperSize::Letter,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaperSize {
    #[default]
    Letter,
    A4,
}

#[derive(Debug, Clone)]
pub struct PreparedReport {
    pub title: String,
    pub created_at_ms: u128,
    pub duration_ms: u64,
    pub report: ExportReportInput,
    pub options: ExportDocumentOptions,
    pub notes_markdown: String,
    pub transcript: Vec<ReportTranscriptSegment>,
}

#[derive(Debug, Clone)]
pub struct ReportTranscriptSegment {
    pub speaker: String,
    pub channel: String,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone)]
pub struct RenderedReport {
    pub bytes: Vec<u8>,
    pub page_count: usize,
    pub warning_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MarkdownBlock {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    Bullet {
        depth: usize,
        ordered: bool,
        checked: Option<bool>,
        text: String,
    },
    Code(String),
    Rule,
}

#[derive(Debug, Clone)]
struct TextCapture {
    kind: CaptureKind,
    text: String,
    checked: Option<bool>,
}

#[derive(Debug, Clone)]
enum CaptureKind {
    Heading(u8),
    Paragraph,
    Bullet { depth: usize, ordered: bool },
    Code,
}

#[derive(Debug, Clone, Copy)]
enum PdfFontKind {
    Regular,
    Bold,
}

#[derive(Debug, Clone)]
struct PdfFlowItem {
    text: String,
    font: PdfFontKind,
    size: f32,
    line_height: f32,
    indent: f32,
    before: f32,
    after: f32,
    color: (f32, f32, f32),
    bookmark: Option<String>,
}

#[derive(Debug, Clone)]
struct PdfPlacedLine {
    text: String,
    font: PdfFontKind,
    size: f32,
    x: f32,
    y: f32,
    color: (f32, f32, f32),
}

#[derive(Debug, Clone)]
struct PdfBookmark {
    name: String,
    page_index: usize,
    y: f32,
}

struct PdfFonts {
    regular: Font,
    bold: Font,
    regular_metrics: Face<'static>,
    bold_metrics: Face<'static>,
}

#[derive(Debug, Clone, Default)]
struct DocxParagraphOptions {
    style: Option<&'static str>,
    before: u32,
    after: u32,
    line: u32,
    keep_next: bool,
    keep_lines: bool,
    widow_control: bool,
    numbering: Option<(u32, usize)>,
    outline_level: Option<u8>,
    align: Option<&'static str>,
}

#[derive(Debug, Clone)]
struct DocxRun {
    text: String,
    size: u32,
    bold: bool,
    italic: bool,
    color: Option<&'static str>,
    font: Option<&'static str>,
}

impl DocxRun {
    fn new(text: impl Into<String>, size: u32) -> Self {
        Self {
            text: text.into(),
            size,
            bold: false,
            italic: false,
            color: None,
            font: None,
        }
    }

    fn bold(mut self) -> Self {
        self.bold = true;
        self
    }

    fn italic(mut self) -> Self {
        self.italic = true;
        self
    }

    fn color(mut self, color: &'static str) -> Self {
        self.color = Some(color);
        self
    }

    fn font(mut self, font: &'static str) -> Self {
        self.font = Some(font);
        self
    }
}

fn default_true() -> bool {
    true
}

impl PaperSize {
    fn pdf_dimensions(self) -> (f32, f32) {
        match self {
            Self::Letter => (612.0, 792.0),
            Self::A4 => (595.28, 841.89),
        }
    }

    fn docx_dimensions(self) -> (u32, u32) {
        match self {
            Self::Letter => (12_240, 15_840),
            Self::A4 => (11_906, 16_838),
        }
    }
}

impl PreparedReport {
    pub fn validate(&self) -> Result<(), String> {
        validate_text("title", &self.title, MAX_REPORT_ITEM_BYTES)?;
        validate_text("summary", &self.report.summary, MAX_REPORT_SUMMARY_BYTES)?;
        validate_text("notes", &self.notes_markdown, MAX_NOTES_BYTES)?;
        validate_items("decisions", &self.report.decisions)?;
        validate_items("actions", &self.report.actions)?;
        validate_items("risks", &self.report.risks)?;
        validate_items("questions", &self.report.questions)?;
        if self.transcript.len() > MAX_TRANSCRIPT_SEGMENTS {
            return Err(format!(
                "transcript exceeds the {MAX_TRANSCRIPT_SEGMENTS} segment export limit"
            ));
        }
        for (index, segment) in self.transcript.iter().enumerate() {
            validate_text(
                &format!("transcript[{index}].speaker"),
                &segment.speaker,
                MAX_REPORT_ITEM_BYTES,
            )?;
            validate_text(
                &format!("transcript[{index}].channel"),
                &segment.channel,
                MAX_REPORT_ITEM_BYTES,
            )?;
            validate_text(
                &format!("transcript[{index}].text"),
                &segment.text,
                MAX_TRANSCRIPT_TEXT_BYTES,
            )?;
        }
        Ok(())
    }
}

pub fn render_markdown(report: &PreparedReport) -> Result<String, String> {
    report.validate()?;
    let mut markdown = format!(
        "# {}\n\n{}\n\n",
        report.title.trim(),
        report_metadata(report)
    );
    if report.options.include_summary && !report.report.summary.trim().is_empty() {
        markdown.push_str("## Executive Summary\n\n");
        markdown.push_str(report.report.summary.trim());
        markdown.push_str("\n\n");
    }
    append_markdown_items(
        &mut markdown,
        "Decisions",
        &report.report.decisions,
        report.options.include_decisions,
        report.options.include_timestamps,
    );
    if report.options.include_actions && !report.report.actions.is_empty() {
        markdown.push_str("## Action Items\n\n");
        markdown.push_str("| Action item | Owner | Due date | Status | Source |\n");
        markdown.push_str("| --- | --- | --- | --- | --- |\n");
        for item in &report.report.actions {
            markdown.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                markdown_table_text(&item.text),
                markdown_table_text(value_or_not_set(&item.owner)),
                markdown_table_text(value_or_not_set(&item.due_date)),
                markdown_table_text(value_or_open(&item.status)),
                markdown_table_text(&report_item_source(item, report.options.include_timestamps)),
            ));
        }
        markdown.push('\n');
    }
    append_markdown_items(
        &mut markdown,
        "Risks",
        &report.report.risks,
        report.options.include_risks,
        report.options.include_timestamps,
    );
    append_markdown_items(
        &mut markdown,
        "Open Questions",
        &report.report.questions,
        report.options.include_questions,
        report.options.include_timestamps,
    );
    if report.options.include_notes {
        markdown.push_str("## Manual Notes\n\n");
        if report.notes_markdown.trim().is_empty() {
            markdown.push_str("_No meeting notes were included._\n\n");
        } else {
            markdown.push_str(report.notes_markdown.trim());
            markdown.push_str("\n\n");
        }
    }
    if report.options.include_transcript {
        markdown.push_str("## Transcript\n\n");
        if report.transcript.is_empty() {
            markdown.push_str("_No transcript segments were included._\n\n");
        } else {
            for segment in &report.transcript {
                markdown.push_str(&format!(
                    "- **{}** {}\n",
                    transcript_label(segment, report.options.include_timestamps)
                        .trim_end_matches(' '),
                    segment.text.trim()
                ));
            }
            markdown.push('\n');
        }
    }
    markdown.push_str("---\n\n_Generated locally by Candor. No cloud processing._\n");
    Ok(markdown)
}

fn append_markdown_items(
    markdown: &mut String,
    heading: &str,
    items: &[ExportReportItemInput],
    included: bool,
    include_timestamps: bool,
) {
    if !included || items.is_empty() {
        return;
    }
    markdown.push_str(&format!("## {heading}\n\n"));
    for item in items {
        let source = report_item_source(item, include_timestamps);
        if source.is_empty() {
            markdown.push_str(&format!("- {}\n", item.text.trim()));
        } else {
            markdown.push_str(&format!("- {} _({source})_\n", item.text.trim()));
        }
    }
    markdown.push('\n');
}

fn markdown_table_text(value: &str) -> String {
    value
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string()
}

fn validate_items(label: &str, items: &[ExportReportItemInput]) -> Result<(), String> {
    if items.len() > MAX_REPORT_ITEMS {
        return Err(format!(
            "{label} exceeds the {MAX_REPORT_ITEMS} item export limit"
        ));
    }
    for (index, item) in items.iter().enumerate() {
        for (field, value) in [
            ("text", item.text.as_str()),
            ("speaker", item.speaker.as_str()),
            ("owner", item.owner.as_str()),
            ("dueDate", item.due_date.as_str()),
            ("status", item.status.as_str()),
        ] {
            validate_text(
                &format!("{label}[{index}].{field}"),
                value,
                MAX_REPORT_ITEM_BYTES,
            )?;
        }
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!("{label} exceeds the {max_bytes} byte export limit"));
    }
    if value
        .chars()
        .any(|ch| ch == '\0' || (ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')))
    {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(())
}

pub fn render_docx(report: &PreparedReport) -> Result<RenderedReport, String> {
    report.validate()?;
    let parts = [
        ("[Content_Types].xml", docx_content_types_xml()?),
        ("_rels/.rels", docx_root_relationships_xml()?),
        ("docProps/core.xml", docx_core_properties_xml(report)?),
        ("docProps/app.xml", docx_app_properties_xml()?),
        ("docProps/custom.xml", docx_custom_properties_xml()?),
        ("word/document.xml", docx_document_xml(report)?),
        ("word/styles.xml", docx_styles_xml()?),
        ("word/numbering.xml", docx_numbering_xml()?),
        ("word/footer1.xml", docx_footer_xml()?),
        ("word/settings.xml", docx_settings_xml()?),
        (
            "word/_rels/document.xml.rels",
            docx_document_relationships_xml()?,
        ),
    ];
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    let file_options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (name, bytes) in parts {
        archive
            .start_file(name, file_options)
            .map_err(|error| format!("Word export could not start {name}: {error}"))?;
        archive
            .write_all(&bytes)
            .map_err(|error| format!("Word export could not write {name}: {error}"))?;
    }
    let cursor = archive
        .finish()
        .map_err(|error| format!("Word export packaging failed: {error}"))?;
    let bytes = cursor.into_inner();
    if bytes.len() < 100 || !bytes.starts_with(b"PK") {
        return Err("Word export did not produce a valid Open XML package".to_string());
    }
    Ok(RenderedReport {
        bytes,
        page_count: 0,
        warning_count: 0,
    })
}

fn docx_document_xml(report: &PreparedReport) -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "w:document",
        &[
            (
                "xmlns:w",
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            ),
            (
                "xmlns:r",
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            ),
        ],
    )?;
    xml_start(&mut writer, "w:body", &[])?;
    write_docx_paragraph(
        &mut writer,
        DocxParagraphOptions {
            style: Some("Title"),
            after: 120,
            keep_next: true,
            keep_lines: true,
            outline_level: Some(0),
            ..Default::default()
        },
        &[DocxRun::new(report.title.trim(), 38).bold()],
    )?;
    write_docx_paragraph(
        &mut writer,
        DocxParagraphOptions {
            after: 280,
            line: 240,
            ..Default::default()
        },
        &[DocxRun::new(report_metadata(report), 18).color("667085")],
    )?;

    if report.options.include_summary && !report.report.summary.trim().is_empty() {
        write_docx_heading(&mut writer, "Executive Summary", 1)?;
        write_docx_paragraphs(&mut writer, &report.report.summary)?;
    }
    if report.options.include_decisions && !report.report.decisions.is_empty() {
        write_docx_heading(&mut writer, "Decisions", 1)?;
        write_docx_items(
            &mut writer,
            &report.report.decisions,
            report.options.include_timestamps,
        )?;
    }
    if report.options.include_actions && !report.report.actions.is_empty() {
        write_docx_heading(&mut writer, "Action Items", 1)?;
        write_docx_action_table(
            &mut writer,
            &report.report.actions,
            report.options.include_timestamps,
        )?;
    }
    if report.options.include_risks && !report.report.risks.is_empty() {
        write_docx_heading(&mut writer, "Risks", 1)?;
        write_docx_items(
            &mut writer,
            &report.report.risks,
            report.options.include_timestamps,
        )?;
    }
    if report.options.include_questions && !report.report.questions.is_empty() {
        write_docx_heading(&mut writer, "Open Questions", 1)?;
        write_docx_items(
            &mut writer,
            &report.report.questions,
            report.options.include_timestamps,
        )?;
    }
    if report.options.include_notes {
        write_docx_heading(&mut writer, "Manual Notes", 1)?;
        let blocks = markdown_blocks(&report.notes_markdown);
        if blocks.is_empty() {
            write_docx_muted(&mut writer, "No meeting notes were included.")?;
        } else {
            for block in blocks {
                write_docx_markdown_block(&mut writer, block)?;
            }
        }
    }
    if report.options.include_transcript {
        write_docx_heading(&mut writer, "Transcript", 1)?;
        if report.transcript.is_empty() {
            write_docx_muted(&mut writer, "No transcript segments were included.")?;
        } else {
            for segment in &report.transcript {
                write_docx_paragraph(
                    &mut writer,
                    DocxParagraphOptions {
                        after: 100,
                        line: 276,
                        keep_lines: true,
                        widow_control: true,
                        ..Default::default()
                    },
                    &[
                        DocxRun::new(
                            transcript_label(segment, report.options.include_timestamps),
                            18,
                        )
                        .bold(),
                        DocxRun::new(segment.text.trim(), 18),
                    ],
                )?;
            }
        }
    }

    let (page_width, page_height) = report.options.paper_size.docx_dimensions();
    let page_width = page_width.to_string();
    let page_height = page_height.to_string();
    xml_start(&mut writer, "w:sectPr", &[])?;
    xml_empty(
        &mut writer,
        "w:footerReference",
        &[("w:type", "default"), ("r:id", "rId3")],
    )?;
    xml_empty(
        &mut writer,
        "w:pgSz",
        &[("w:w", page_width.as_str()), ("w:h", page_height.as_str())],
    )?;
    xml_empty(
        &mut writer,
        "w:pgMar",
        &[
            ("w:top", "900"),
            ("w:right", "900"),
            ("w:bottom", "900"),
            ("w:left", "900"),
            ("w:header", "360"),
            ("w:footer", "360"),
            ("w:gutter", "0"),
        ],
    )?;
    xml_empty(&mut writer, "w:cols", &[("w:space", "720")])?;
    xml_empty(&mut writer, "w:docGrid", &[("w:linePitch", "360")])?;
    xml_end(&mut writer, "w:sectPr")?;
    xml_end(&mut writer, "w:body")?;
    xml_end(&mut writer, "w:document")?;
    Ok(writer.into_inner())
}

fn write_docx_heading(writer: &mut Writer<Vec<u8>>, text: &str, level: u8) -> Result<(), String> {
    let size = if level <= 1 { 28 } else { 24 };
    let style = if level <= 1 { "Heading1" } else { "Heading2" };
    write_docx_paragraph(
        writer,
        DocxParagraphOptions {
            style: Some(style),
            before: 260,
            after: 100,
            keep_next: true,
            keep_lines: true,
            outline_level: Some(level.saturating_sub(1).min(8)),
            ..Default::default()
        },
        &[DocxRun::new(text, size).bold().color("111827")],
    )
}

fn write_docx_paragraphs(writer: &mut Writer<Vec<u8>>, text: &str) -> Result<(), String> {
    for paragraph in split_paragraphs(text) {
        write_docx_paragraph(
            writer,
            DocxParagraphOptions {
                after: 140,
                line: 276,
                widow_control: true,
                ..Default::default()
            },
            &[DocxRun::new(paragraph, 20)],
        )?;
    }
    Ok(())
}

fn write_docx_muted(writer: &mut Writer<Vec<u8>>, text: &str) -> Result<(), String> {
    write_docx_paragraph(
        writer,
        DocxParagraphOptions {
            after: 140,
            line: 240,
            ..Default::default()
        },
        &[DocxRun::new(text, 18).italic().color("667085")],
    )
}

fn write_docx_items(
    writer: &mut Writer<Vec<u8>>,
    items: &[ExportReportItemInput],
    include_timestamps: bool,
) -> Result<(), String> {
    for item in items {
        let source = report_item_source(item, include_timestamps);
        let mut runs = vec![DocxRun::new(item.text.trim(), 20)];
        if !source.is_empty() {
            runs.push(DocxRun::new(format!("  ({source})"), 16).color("667085"));
        }
        write_docx_paragraph(
            writer,
            DocxParagraphOptions {
                after: 100,
                line: 276,
                widow_control: true,
                numbering: Some((1, 0)),
                ..Default::default()
            },
            &runs,
        )?;
    }
    Ok(())
}

fn write_docx_action_table(
    writer: &mut Writer<Vec<u8>>,
    items: &[ExportReportItemInput],
    include_timestamps: bool,
) -> Result<(), String> {
    let widths = [3_900, 1_300, 1_300, 1_100, 2_000];
    xml_start(writer, "w:tbl", &[])?;
    xml_start(writer, "w:tblPr", &[])?;
    xml_empty(writer, "w:tblW", &[("w:w", "9600"), ("w:type", "dxa")])?;
    xml_empty(writer, "w:tblLayout", &[("w:type", "fixed")])?;
    xml_start(writer, "w:tblBorders", &[])?;
    for edge in ["top", "left", "bottom", "right", "insideH", "insideV"] {
        xml_empty(
            writer,
            &format!("w:{edge}"),
            &[
                ("w:val", "single"),
                ("w:sz", "4"),
                ("w:space", "0"),
                ("w:color", "D0D5DD"),
            ],
        )?;
    }
    xml_end(writer, "w:tblBorders")?;
    xml_end(writer, "w:tblPr")?;
    xml_start(writer, "w:tblGrid", &[])?;
    for width in widths {
        let width = width.to_string();
        xml_empty(writer, "w:gridCol", &[("w:w", width.as_str())])?;
    }
    xml_end(writer, "w:tblGrid")?;
    write_docx_table_row(
        writer,
        &[
            ("Action item", widths[0]),
            ("Owner", widths[1]),
            ("Due date", widths[2]),
            ("Status", widths[3]),
            ("Source", widths[4]),
        ],
        true,
    )?;
    for item in items {
        let source = report_item_source(item, include_timestamps);
        write_docx_table_row(
            writer,
            &[
                (item.text.trim(), widths[0]),
                (value_or_not_set(&item.owner), widths[1]),
                (value_or_not_set(&item.due_date), widths[2]),
                (value_or_open(&item.status), widths[3]),
                (source.as_str(), widths[4]),
            ],
            false,
        )?;
    }
    xml_end(writer, "w:tbl")?;
    Ok(())
}

fn write_docx_table_row(
    writer: &mut Writer<Vec<u8>>,
    cells: &[(&str, usize)],
    header: bool,
) -> Result<(), String> {
    xml_start(writer, "w:tr", &[])?;
    if header {
        xml_start(writer, "w:trPr", &[])?;
        xml_empty(writer, "w:tblHeader", &[])?;
        xml_end(writer, "w:trPr")?;
    }
    for (text, width) in cells {
        xml_start(writer, "w:tc", &[])?;
        xml_start(writer, "w:tcPr", &[])?;
        let width = width.to_string();
        xml_empty(
            writer,
            "w:tcW",
            &[("w:w", width.as_str()), ("w:type", "dxa")],
        )?;
        if header {
            xml_empty(writer, "w:shd", &[("w:val", "clear"), ("w:fill", "F2F4F7")])?;
        }
        xml_empty(writer, "w:vAlign", &[("w:val", "center")])?;
        xml_end(writer, "w:tcPr")?;
        let run = if header {
            DocxRun::new(*text, 17).bold()
        } else {
            DocxRun::new(*text, 17)
        };
        write_docx_paragraph(
            writer,
            DocxParagraphOptions {
                after: 60,
                line: 240,
                widow_control: true,
                ..Default::default()
            },
            &[run],
        )?;
        xml_end(writer, "w:tc")?;
    }
    xml_end(writer, "w:tr")?;
    Ok(())
}

fn write_docx_markdown_block(
    writer: &mut Writer<Vec<u8>>,
    block: MarkdownBlock,
) -> Result<(), String> {
    match block {
        MarkdownBlock::Heading { level, text } => write_docx_heading(writer, &text, level.max(2)),
        MarkdownBlock::Paragraph(text) => write_docx_paragraphs(writer, &text),
        MarkdownBlock::Bullet {
            depth,
            ordered,
            checked,
            text,
        } => {
            let marker = match checked {
                Some(true) => "[x] ",
                Some(false) => "[ ] ",
                None => "",
            };
            let numbering_id = if ordered { 2 } else { 1 };
            write_docx_paragraph(
                writer,
                DocxParagraphOptions {
                    after: 80,
                    line: 276,
                    widow_control: true,
                    numbering: Some((numbering_id, depth.min(8))),
                    ..Default::default()
                },
                &[DocxRun::new(format!("{marker}{text}"), 20)],
            )
        }
        MarkdownBlock::Code(text) => write_docx_paragraph(
            writer,
            DocxParagraphOptions {
                after: 120,
                line: 240,
                keep_lines: true,
                ..Default::default()
            },
            &[DocxRun::new(text, 17).font("Consolas")],
        ),
        MarkdownBlock::Rule => write_docx_paragraph(
            writer,
            DocxParagraphOptions {
                after: 100,
                ..Default::default()
            },
            &[DocxRun::new("________________________________", 18).color("D0D5DD")],
        ),
    }
}

fn write_docx_paragraph(
    writer: &mut Writer<Vec<u8>>,
    options: DocxParagraphOptions,
    runs: &[DocxRun],
) -> Result<(), String> {
    xml_start(writer, "w:p", &[])?;
    xml_start(writer, "w:pPr", &[])?;
    if let Some(style) = options.style {
        xml_empty(writer, "w:pStyle", &[("w:val", style)])?;
    }
    if options.keep_next {
        xml_empty(writer, "w:keepNext", &[])?;
    }
    if options.keep_lines {
        xml_empty(writer, "w:keepLines", &[])?;
    }
    if options.widow_control {
        xml_empty(writer, "w:widowControl", &[])?;
    }
    if let Some((numbering_id, depth)) = options.numbering {
        let numbering_id = numbering_id.to_string();
        let depth = depth.min(8).to_string();
        xml_start(writer, "w:numPr", &[])?;
        xml_empty(writer, "w:ilvl", &[("w:val", depth.as_str())])?;
        xml_empty(writer, "w:numId", &[("w:val", numbering_id.as_str())])?;
        xml_end(writer, "w:numPr")?;
    }
    if options.before > 0 || options.after > 0 || options.line > 0 {
        let before = options.before.to_string();
        let after = options.after.to_string();
        let line = options.line.to_string();
        let mut attributes = Vec::new();
        if options.before > 0 {
            attributes.push(("w:before", before.as_str()));
        }
        if options.after > 0 {
            attributes.push(("w:after", after.as_str()));
        }
        if options.line > 0 {
            attributes.push(("w:line", line.as_str()));
            attributes.push(("w:lineRule", "auto"));
        }
        xml_empty(writer, "w:spacing", &attributes)?;
    }
    if let Some(align) = options.align {
        xml_empty(writer, "w:jc", &[("w:val", align)])?;
    }
    if let Some(level) = options.outline_level {
        let level = level.min(8).to_string();
        xml_empty(writer, "w:outlineLvl", &[("w:val", level.as_str())])?;
    }
    xml_end(writer, "w:pPr")?;
    for run in runs {
        write_docx_run(writer, run)?;
    }
    xml_end(writer, "w:p")?;
    Ok(())
}

fn write_docx_run(writer: &mut Writer<Vec<u8>>, run: &DocxRun) -> Result<(), String> {
    xml_start(writer, "w:r", &[])?;
    xml_start(writer, "w:rPr", &[])?;
    if let Some(font) = run.font {
        xml_empty(
            writer,
            "w:rFonts",
            &[
                ("w:ascii", font),
                ("w:hAnsi", font),
                ("w:eastAsia", font),
                ("w:cs", font),
            ],
        )?;
    }
    if run.bold {
        xml_empty(writer, "w:b", &[])?;
        xml_empty(writer, "w:bCs", &[])?;
    }
    if run.italic {
        xml_empty(writer, "w:i", &[])?;
        xml_empty(writer, "w:iCs", &[])?;
    }
    if let Some(color) = run.color {
        xml_empty(writer, "w:color", &[("w:val", color)])?;
    }
    let size = run.size.to_string();
    xml_empty(writer, "w:sz", &[("w:val", size.as_str())])?;
    xml_empty(writer, "w:szCs", &[("w:val", size.as_str())])?;
    xml_end(writer, "w:rPr")?;
    for (index, line) in run.text.replace("\r\n", "\n").split('\n').enumerate() {
        if index > 0 {
            xml_empty(writer, "w:br", &[])?;
        }
        xml_text_element(writer, "w:t", line, &[("xml:space", "preserve")])?;
    }
    xml_end(writer, "w:r")?;
    Ok(())
}

fn docx_content_types_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "Types",
        &[(
            "xmlns",
            "http://schemas.openxmlformats.org/package/2006/content-types",
        )],
    )?;
    for (extension, content_type) in [
        (
            "rels",
            "application/vnd.openxmlformats-package.relationships+xml",
        ),
        ("xml", "application/xml"),
    ] {
        xml_empty(
            &mut writer,
            "Default",
            &[("Extension", extension), ("ContentType", content_type)],
        )?;
    }
    for (part_name, content_type) in [
        (
            "/word/document.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        ),
        (
            "/word/styles.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
        ),
        (
            "/word/numbering.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
        ),
        (
            "/word/footer1.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
        ),
        (
            "/word/settings.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
        ),
        (
            "/docProps/core.xml",
            "application/vnd.openxmlformats-package.core-properties+xml",
        ),
        (
            "/docProps/app.xml",
            "application/vnd.openxmlformats-officedocument.extended-properties+xml",
        ),
        (
            "/docProps/custom.xml",
            "application/vnd.openxmlformats-officedocument.custom-properties+xml",
        ),
    ] {
        xml_empty(
            &mut writer,
            "Override",
            &[("PartName", part_name), ("ContentType", content_type)],
        )?;
    }
    xml_end(&mut writer, "Types")?;
    Ok(writer.into_inner())
}

fn docx_root_relationships_xml() -> Result<Vec<u8>, String> {
    let mut writer = relationships_writer()?;
    for (id, kind, target) in [
        (
            "rId1",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
            "word/document.xml",
        ),
        (
            "rId2",
            "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
            "docProps/core.xml",
        ),
        (
            "rId3",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
            "docProps/app.xml",
        ),
        (
            "rId4",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
            "docProps/custom.xml",
        ),
    ] {
        xml_empty(
            &mut writer,
            "Relationship",
            &[("Id", id), ("Type", kind), ("Target", target)],
        )?;
    }
    xml_end(&mut writer, "Relationships")?;
    Ok(writer.into_inner())
}

fn docx_document_relationships_xml() -> Result<Vec<u8>, String> {
    let mut writer = relationships_writer()?;
    for (id, kind, target) in [
        (
            "rId1",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
            "styles.xml",
        ),
        (
            "rId2",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
            "numbering.xml",
        ),
        (
            "rId3",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
            "footer1.xml",
        ),
        (
            "rId4",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
            "settings.xml",
        ),
    ] {
        xml_empty(
            &mut writer,
            "Relationship",
            &[("Id", id), ("Type", kind), ("Target", target)],
        )?;
    }
    xml_end(&mut writer, "Relationships")?;
    Ok(writer.into_inner())
}

fn relationships_writer() -> Result<Writer<Vec<u8>>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "Relationships",
        &[(
            "xmlns",
            "http://schemas.openxmlformats.org/package/2006/relationships",
        )],
    )?;
    Ok(writer)
}

fn docx_core_properties_xml(report: &PreparedReport) -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "cp:coreProperties",
        &[
            (
                "xmlns:cp",
                "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
            ),
            ("xmlns:dc", "http://purl.org/dc/elements/1.1/"),
            ("xmlns:dcterms", "http://purl.org/dc/terms/"),
            ("xmlns:dcmitype", "http://purl.org/dc/dcmitype/"),
            ("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance"),
        ],
    )?;
    xml_text_element(&mut writer, "dc:title", report.title.trim(), &[])?;
    xml_text_element(&mut writer, "dc:creator", "Candor", &[])?;
    xml_text_element(&mut writer, "cp:lastModifiedBy", "Candor", &[])?;
    xml_text_element(
        &mut writer,
        "dc:description",
        "Local-only meeting report generated by Candor.",
        &[],
    )?;
    let timestamp = docx_timestamp(report.created_at_ms);
    xml_text_element(
        &mut writer,
        "dcterms:created",
        &timestamp,
        &[("xsi:type", "dcterms:W3CDTF")],
    )?;
    xml_text_element(
        &mut writer,
        "dcterms:modified",
        &timestamp,
        &[("xsi:type", "dcterms:W3CDTF")],
    )?;
    xml_end(&mut writer, "cp:coreProperties")?;
    Ok(writer.into_inner())
}

fn docx_app_properties_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "Properties",
        &[
            (
                "xmlns",
                "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
            ),
            (
                "xmlns:vt",
                "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
            ),
        ],
    )?;
    xml_text_element(&mut writer, "Application", "Candor", &[])?;
    xml_text_element(&mut writer, "AppVersion", "3.0", &[])?;
    xml_text_element(&mut writer, "Company", "", &[])?;
    xml_end(&mut writer, "Properties")?;
    Ok(writer.into_inner())
}

fn docx_custom_properties_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "Properties",
        &[
            (
                "xmlns",
                "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
            ),
            (
                "xmlns:vt",
                "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
            ),
        ],
    )?;
    xml_start(
        &mut writer,
        "property",
        &[
            ("fmtid", "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"),
            ("pid", "2"),
            ("name", "CandorLocalOnly"),
        ],
    )?;
    xml_text_element(&mut writer, "vt:bool", "true", &[])?;
    xml_end(&mut writer, "property")?;
    xml_end(&mut writer, "Properties")?;
    Ok(writer.into_inner())
}

fn docx_styles_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "w:styles",
        &[(
            "xmlns:w",
            "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        )],
    )?;
    xml_start(&mut writer, "w:docDefaults", &[])?;
    xml_start(&mut writer, "w:rPrDefault", &[])?;
    xml_start(&mut writer, "w:rPr", &[])?;
    xml_empty(
        &mut writer,
        "w:rFonts",
        &[
            ("w:ascii", "Noto Sans"),
            ("w:hAnsi", "Noto Sans"),
            ("w:eastAsia", "Noto Sans"),
            ("w:cs", "Noto Sans"),
        ],
    )?;
    xml_empty(&mut writer, "w:color", &[("w:val", "111827")])?;
    xml_empty(&mut writer, "w:sz", &[("w:val", "20")])?;
    xml_empty(&mut writer, "w:szCs", &[("w:val", "20")])?;
    xml_end(&mut writer, "w:rPr")?;
    xml_end(&mut writer, "w:rPrDefault")?;
    xml_start(&mut writer, "w:pPrDefault", &[])?;
    xml_start(&mut writer, "w:pPr", &[])?;
    xml_empty(
        &mut writer,
        "w:spacing",
        &[
            ("w:after", "120"),
            ("w:line", "276"),
            ("w:lineRule", "auto"),
        ],
    )?;
    xml_end(&mut writer, "w:pPr")?;
    xml_end(&mut writer, "w:pPrDefault")?;
    xml_end(&mut writer, "w:docDefaults")?;
    write_docx_style(&mut writer, "Normal", "Normal", None, 20, false, None)?;
    write_docx_style(
        &mut writer,
        "Title",
        "Title",
        Some("Normal"),
        38,
        true,
        Some(0),
    )?;
    write_docx_style(
        &mut writer,
        "Heading1",
        "heading 1",
        Some("Normal"),
        28,
        true,
        Some(0),
    )?;
    write_docx_style(
        &mut writer,
        "Heading2",
        "heading 2",
        Some("Normal"),
        24,
        true,
        Some(1),
    )?;
    xml_end(&mut writer, "w:styles")?;
    Ok(writer.into_inner())
}

fn write_docx_style(
    writer: &mut Writer<Vec<u8>>,
    style_id: &str,
    name: &str,
    based_on: Option<&str>,
    size: u32,
    bold: bool,
    outline_level: Option<u8>,
) -> Result<(), String> {
    let mut attributes = vec![("w:type", "paragraph"), ("w:styleId", style_id)];
    if style_id == "Normal" {
        attributes.push(("w:default", "1"));
    }
    xml_start(writer, "w:style", &attributes)?;
    xml_empty(writer, "w:name", &[("w:val", name)])?;
    if let Some(based_on) = based_on {
        xml_empty(writer, "w:basedOn", &[("w:val", based_on)])?;
    }
    xml_empty(writer, "w:qFormat", &[])?;
    if let Some(level) = outline_level {
        let level = level.to_string();
        xml_start(writer, "w:pPr", &[])?;
        xml_empty(writer, "w:outlineLvl", &[("w:val", level.as_str())])?;
        xml_end(writer, "w:pPr")?;
    }
    xml_start(writer, "w:rPr", &[])?;
    if bold {
        xml_empty(writer, "w:b", &[])?;
        xml_empty(writer, "w:bCs", &[])?;
    }
    let size = size.to_string();
    xml_empty(writer, "w:sz", &[("w:val", size.as_str())])?;
    xml_empty(writer, "w:szCs", &[("w:val", size.as_str())])?;
    xml_end(writer, "w:rPr")?;
    xml_end(writer, "w:style")?;
    Ok(())
}

fn docx_numbering_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "w:numbering",
        &[(
            "xmlns:w",
            "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        )],
    )?;
    write_docx_abstract_numbering(&mut writer, 1, false)?;
    write_docx_abstract_numbering(&mut writer, 2, true)?;
    for id in [1_u32, 2_u32] {
        let id_text = id.to_string();
        xml_start(&mut writer, "w:num", &[("w:numId", id_text.as_str())])?;
        xml_empty(
            &mut writer,
            "w:abstractNumId",
            &[("w:val", id_text.as_str())],
        )?;
        xml_end(&mut writer, "w:num")?;
    }
    xml_end(&mut writer, "w:numbering")?;
    Ok(writer.into_inner())
}

fn write_docx_abstract_numbering(
    writer: &mut Writer<Vec<u8>>,
    id: u32,
    ordered: bool,
) -> Result<(), String> {
    let id_text = id.to_string();
    xml_start(
        writer,
        "w:abstractNum",
        &[("w:abstractNumId", id_text.as_str())],
    )?;
    xml_empty(writer, "w:multiLevelType", &[("w:val", "multilevel")])?;
    for level in 0..=8_usize {
        let level_text = level.to_string();
        let left = (720 + level * 360).to_string();
        let marker_position = (360 + level * 360).to_string();
        let number_text = format!("%{}.", level + 1);
        xml_start(writer, "w:lvl", &[("w:ilvl", level_text.as_str())])?;
        xml_empty(writer, "w:start", &[("w:val", "1")])?;
        xml_empty(
            writer,
            "w:numFmt",
            &[("w:val", if ordered { "decimal" } else { "bullet" })],
        )?;
        xml_empty(
            writer,
            "w:lvlText",
            &[(
                "w:val",
                if ordered {
                    number_text.as_str()
                } else {
                    "\u{2022}"
                },
            )],
        )?;
        xml_empty(writer, "w:lvlJc", &[("w:val", "left")])?;
        xml_start(writer, "w:pPr", &[])?;
        xml_start(writer, "w:tabs", &[])?;
        xml_empty(
            writer,
            "w:tab",
            &[("w:val", "num"), ("w:pos", marker_position.as_str())],
        )?;
        xml_end(writer, "w:tabs")?;
        xml_empty(
            writer,
            "w:ind",
            &[("w:left", left.as_str()), ("w:hanging", "360")],
        )?;
        xml_end(writer, "w:pPr")?;
        if !ordered {
            xml_start(writer, "w:rPr", &[])?;
            xml_empty(
                writer,
                "w:rFonts",
                &[("w:ascii", "Arial"), ("w:hAnsi", "Arial")],
            )?;
            xml_end(writer, "w:rPr")?;
        }
        xml_end(writer, "w:lvl")?;
    }
    xml_end(writer, "w:abstractNum")?;
    Ok(())
}

fn docx_footer_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "w:ftr",
        &[
            (
                "xmlns:w",
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            ),
            (
                "xmlns:r",
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            ),
        ],
    )?;
    xml_start(&mut writer, "w:p", &[])?;
    xml_start(&mut writer, "w:pPr", &[])?;
    xml_empty(&mut writer, "w:jc", &[("w:val", "center")])?;
    xml_end(&mut writer, "w:pPr")?;
    write_docx_run(
        &mut writer,
        &DocxRun::new("Generated locally by Candor | Page ", 16).color("667085"),
    )?;
    write_docx_field(&mut writer, " PAGE ", "1")?;
    write_docx_run(&mut writer, &DocxRun::new(" of ", 16).color("667085"))?;
    write_docx_field(&mut writer, " NUMPAGES ", "1")?;
    write_docx_run(
        &mut writer,
        &DocxRun::new(" | Local only", 16).color("667085"),
    )?;
    xml_end(&mut writer, "w:p")?;
    xml_end(&mut writer, "w:ftr")?;
    Ok(writer.into_inner())
}

fn write_docx_field(
    writer: &mut Writer<Vec<u8>>,
    instruction: &str,
    fallback: &str,
) -> Result<(), String> {
    xml_start(writer, "w:fldSimple", &[("w:instr", instruction)])?;
    write_docx_run(writer, &DocxRun::new(fallback, 16).color("667085"))?;
    xml_end(writer, "w:fldSimple")?;
    Ok(())
}

fn docx_settings_xml() -> Result<Vec<u8>, String> {
    let mut writer = Writer::new(Vec::new());
    xml_declaration(&mut writer)?;
    xml_start(
        &mut writer,
        "w:settings",
        &[(
            "xmlns:w",
            "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        )],
    )?;
    xml_empty(
        &mut writer,
        "w:zoom",
        &[("w:val", "bestFit"), ("w:percent", "100")],
    )?;
    xml_empty(&mut writer, "w:defaultTabStop", &[("w:val", "720")])?;
    xml_empty(
        &mut writer,
        "w:characterSpacingControl",
        &[("w:val", "doNotCompress")],
    )?;
    xml_end(&mut writer, "w:settings")?;
    Ok(writer.into_inner())
}

fn docx_timestamp(ms: u128) -> String {
    OffsetDateTime::from_unix_timestamp((ms / 1000).min(i64::MAX as u128) as i64)
        .map(|value| {
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                value.year(),
                u8::from(value.month()),
                value.day(),
                value.hour(),
                value.minute(),
                value.second()
            )
        })
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn xml_declaration(writer: &mut Writer<Vec<u8>>) -> Result<(), String> {
    writer
        .write_event(XmlEvent::Decl(BytesDecl::new(
            "1.0",
            Some("UTF-8"),
            Some("yes"),
        )))
        .map_err(|error| format!("Open XML declaration failed: {error}"))
}

fn xml_start(
    writer: &mut Writer<Vec<u8>>,
    name: &str,
    attributes: &[(&str, &str)],
) -> Result<(), String> {
    let mut element = BytesStart::new(name);
    for (key, value) in attributes {
        element.push_attribute((*key, *value));
    }
    writer
        .write_event(XmlEvent::Start(element))
        .map_err(|error| format!("Open XML start element {name} failed: {error}"))
}

fn xml_empty(
    writer: &mut Writer<Vec<u8>>,
    name: &str,
    attributes: &[(&str, &str)],
) -> Result<(), String> {
    let mut element = BytesStart::new(name);
    for (key, value) in attributes {
        element.push_attribute((*key, *value));
    }
    writer
        .write_event(XmlEvent::Empty(element))
        .map_err(|error| format!("Open XML empty element {name} failed: {error}"))
}

fn xml_text_element(
    writer: &mut Writer<Vec<u8>>,
    name: &str,
    text: &str,
    attributes: &[(&str, &str)],
) -> Result<(), String> {
    xml_start(writer, name, attributes)?;
    writer
        .write_event(XmlEvent::Text(BytesText::new(text)))
        .map_err(|error| format!("Open XML text for {name} failed: {error}"))?;
    xml_end(writer, name)
}

fn xml_end(writer: &mut Writer<Vec<u8>>, name: &str) -> Result<(), String> {
    writer
        .write_event(XmlEvent::End(BytesEnd::new(name)))
        .map_err(|error| format!("Open XML end element {name} failed: {error}"))
}

pub fn render_pdf(report: &PreparedReport) -> Result<RenderedReport, String> {
    report.validate()?;
    let regular = Font::new(NOTO_SANS_REGULAR.to_vec().into(), 0)
        .ok_or_else(|| "PDF export could not parse bundled Noto Sans Regular".to_string())?;
    let bold = Font::new(NOTO_SANS_BOLD.to_vec().into(), 0)
        .ok_or_else(|| "PDF export could not parse bundled Noto Sans Bold".to_string())?;
    let regular_metrics = Face::from_slice(NOTO_SANS_REGULAR, 0)
        .ok_or_else(|| "PDF export could not measure bundled Noto Sans Regular".to_string())?;
    let bold_metrics = Face::from_slice(NOTO_SANS_BOLD, 0)
        .ok_or_else(|| "PDF export could not measure bundled Noto Sans Bold".to_string())?;
    let fonts = PdfFonts {
        regular,
        bold,
        regular_metrics,
        bold_metrics,
    };
    let flow = pdf_flow(report);
    let (page_width, page_height) = report.options.paper_size.pdf_dimensions();
    let (mut pages, bookmarks) =
        layout_pdf_flow(&flow, &fonts, page_width, page_height, &report.title);
    let page_count = pages.len();
    for (index, lines) in pages.iter_mut().enumerate() {
        add_pdf_footer(
            lines,
            &fonts,
            page_width,
            page_height,
            index + 1,
            page_count,
        );
    }

    let mut document = Document::new();
    document.set_metadata(
        Metadata::new()
            .title(report.title.trim().to_string())
            .description("Local-only meeting report generated by Candor.".to_string())
            .creator("Candor".to_string())
            .producer("Candor local report renderer".to_string())
            .authors(vec!["Candor".to_string()])
            .keywords(vec![
                "meeting notes".to_string(),
                "local-only".to_string(),
                "Candor".to_string(),
            ])
            .language("en".to_string()),
    );
    let page_settings = PageSettings::from_wh(page_width, page_height)
        .ok_or_else(|| "PDF export received invalid page dimensions".to_string())?;
    for lines in pages {
        let mut page = document.start_page_with(page_settings.clone());
        let mut surface = page.surface();
        for line in lines {
            if line.text.is_empty() {
                continue;
            }
            surface.set_fill(Some(Fill {
                paint: rgb::Color::new(
                    pdf_color_channel(line.color.0),
                    pdf_color_channel(line.color.1),
                    pdf_color_channel(line.color.2),
                )
                .into(),
                opacity: NormalizedF32::ONE,
                rule: Default::default(),
            }));
            surface.draw_text(
                Point::from_xy(line.x, line.y),
                pdf_font(&fonts, line.font).clone(),
                line.size,
                &line.text,
                false,
                TextDirection::Auto,
            );
        }
        surface.finish();
        page.finish();
    }
    let mut outline = Outline::new();
    for bookmark in bookmarks {
        outline.push_child(OutlineNode::new(
            bookmark.name,
            XyzDestination::new(
                bookmark.page_index,
                Point::from_xy(54.0, bookmark.y.max(0.0)),
            ),
        ));
    }
    document.set_outline(outline);
    let bytes = document
        .finish()
        .map_err(|error| format!("PDF export serialization failed: {error}"))?;
    if bytes.len() < 100 || !bytes.starts_with(b"%PDF-") {
        return Err("PDF export did not produce a valid PDF header".to_string());
    }
    Ok(RenderedReport {
        bytes,
        page_count,
        warning_count: 0,
    })
}

fn pdf_color_channel(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn pdf_flow(report: &PreparedReport) -> Vec<PdfFlowItem> {
    let mut flow = Vec::new();
    flow.push(pdf_item(
        &report.title,
        PdfFontKind::Bold,
        24.0,
        29.0,
        0.0,
        0.0,
        4.0,
        (0.06, 0.08, 0.12),
        Some(report.title.clone()),
    ));
    flow.push(pdf_item(
        &report_metadata(report),
        PdfFontKind::Regular,
        9.0,
        12.0,
        0.0,
        0.0,
        16.0,
        (0.40, 0.44, 0.52),
        None,
    ));

    if report.options.include_summary && !report.report.summary.trim().is_empty() {
        push_pdf_section(&mut flow, "Executive Summary");
        push_pdf_paragraphs(&mut flow, &report.report.summary, 0.0);
    }
    if report.options.include_decisions && !report.report.decisions.is_empty() {
        push_pdf_section(&mut flow, "Decisions");
        push_pdf_report_items(
            &mut flow,
            &report.report.decisions,
            report.options.include_timestamps,
        );
    }
    if report.options.include_actions && !report.report.actions.is_empty() {
        push_pdf_section(&mut flow, "Action Items");
        for item in &report.report.actions {
            flow.push(pdf_item(
                &format!("\u{2022} {}", item.text.trim()),
                PdfFontKind::Regular,
                10.0,
                14.0,
                12.0,
                1.0,
                1.0,
                (0.08, 0.10, 0.15),
                None,
            ));
            let owner = value_or_not_set(&item.owner);
            let due = value_or_not_set(&item.due_date);
            let status = value_or_open(&item.status);
            let source = report_item_source(item, report.options.include_timestamps);
            flow.push(pdf_item(
                &format!("Owner: {owner} | Due: {due} | Status: {status} | Source: {source}"),
                PdfFontKind::Regular,
                8.0,
                11.0,
                24.0,
                0.0,
                5.0,
                (0.40, 0.44, 0.52),
                None,
            ));
        }
    }
    if report.options.include_risks && !report.report.risks.is_empty() {
        push_pdf_section(&mut flow, "Risks");
        push_pdf_report_items(
            &mut flow,
            &report.report.risks,
            report.options.include_timestamps,
        );
    }
    if report.options.include_questions && !report.report.questions.is_empty() {
        push_pdf_section(&mut flow, "Open Questions");
        push_pdf_report_items(
            &mut flow,
            &report.report.questions,
            report.options.include_timestamps,
        );
    }
    if report.options.include_notes {
        push_pdf_section(&mut flow, "Manual Notes");
        let blocks = markdown_blocks(&report.notes_markdown);
        if blocks.is_empty() {
            flow.push(pdf_muted("No meeting notes were included."));
        } else {
            for block in blocks {
                push_pdf_markdown_block(&mut flow, block);
            }
        }
    }
    if report.options.include_transcript {
        push_pdf_section(&mut flow, "Transcript");
        if report.transcript.is_empty() {
            flow.push(pdf_muted("No transcript segments were included."));
        } else {
            for segment in &report.transcript {
                let label = transcript_label(segment, report.options.include_timestamps);
                flow.push(pdf_item(
                    &format!("{label}{}", segment.text),
                    PdfFontKind::Regular,
                    9.0,
                    13.0,
                    0.0,
                    1.0,
                    5.0,
                    (0.08, 0.10, 0.15),
                    None,
                ));
            }
        }
    }
    flow
}

#[allow(clippy::too_many_arguments)]
fn pdf_item(
    text: &str,
    font: PdfFontKind,
    size: f32,
    line_height: f32,
    indent: f32,
    before: f32,
    after: f32,
    color: (f32, f32, f32),
    bookmark: Option<String>,
) -> PdfFlowItem {
    PdfFlowItem {
        text: text.trim().to_string(),
        font,
        size,
        line_height,
        indent,
        before,
        after,
        color,
        bookmark,
    }
}

fn push_pdf_section(flow: &mut Vec<PdfFlowItem>, title: &str) {
    flow.push(pdf_item(
        title,
        PdfFontKind::Bold,
        14.0,
        18.0,
        0.0,
        12.0,
        5.0,
        (0.06, 0.08, 0.12),
        Some(title.to_string()),
    ));
}

fn push_pdf_paragraphs(flow: &mut Vec<PdfFlowItem>, text: &str, indent: f32) {
    for paragraph in split_paragraphs(text) {
        flow.push(pdf_item(
            &paragraph,
            PdfFontKind::Regular,
            10.0,
            14.0,
            indent,
            0.0,
            6.0,
            (0.08, 0.10, 0.15),
            None,
        ));
    }
}

fn push_pdf_report_items(
    flow: &mut Vec<PdfFlowItem>,
    items: &[ExportReportItemInput],
    include_timestamps: bool,
) {
    for item in items {
        let source = report_item_source(item, include_timestamps);
        let suffix = if source.is_empty() {
            String::new()
        } else {
            format!(" ({source})")
        };
        flow.push(pdf_item(
            &format!("\u{2022} {}{suffix}", item.text.trim()),
            PdfFontKind::Regular,
            10.0,
            14.0,
            12.0,
            1.0,
            4.0,
            (0.08, 0.10, 0.15),
            None,
        ));
    }
}

fn push_pdf_markdown_block(flow: &mut Vec<PdfFlowItem>, block: MarkdownBlock) {
    match block {
        MarkdownBlock::Heading { level, text } => flow.push(pdf_item(
            &text,
            PdfFontKind::Bold,
            if level <= 2 { 12.0 } else { 10.5 },
            if level <= 2 { 16.0 } else { 14.0 },
            0.0,
            7.0,
            3.0,
            (0.10, 0.12, 0.18),
            None,
        )),
        MarkdownBlock::Paragraph(text) => push_pdf_paragraphs(flow, &text, 0.0),
        MarkdownBlock::Bullet {
            depth,
            ordered,
            checked,
            text,
        } => {
            let marker = match checked {
                Some(true) => "[x]",
                Some(false) => "[ ]",
                None if ordered => "-",
                None => "\u{2022}",
            };
            flow.push(pdf_item(
                &format!("{marker} {text}"),
                PdfFontKind::Regular,
                10.0,
                14.0,
                12.0 + depth.min(8) as f32 * 12.0,
                1.0,
                3.0,
                (0.08, 0.10, 0.15),
                None,
            ));
        }
        MarkdownBlock::Code(text) => flow.push(pdf_item(
            &text,
            PdfFontKind::Regular,
            8.5,
            12.0,
            12.0,
            2.0,
            5.0,
            (0.18, 0.20, 0.26),
            None,
        )),
        MarkdownBlock::Rule => flow.push(pdf_item(
            "_______________________________________________",
            PdfFontKind::Regular,
            8.0,
            10.0,
            0.0,
            3.0,
            5.0,
            (0.75, 0.77, 0.82),
            None,
        )),
    }
}

fn pdf_muted(text: &str) -> PdfFlowItem {
    pdf_item(
        text,
        PdfFontKind::Regular,
        9.0,
        13.0,
        0.0,
        0.0,
        6.0,
        (0.40, 0.44, 0.52),
        None,
    )
}

fn layout_pdf_flow(
    flow: &[PdfFlowItem],
    fonts: &PdfFonts,
    page_width: f32,
    page_height: f32,
    title: &str,
) -> (Vec<Vec<PdfPlacedLine>>, Vec<PdfBookmark>) {
    const LEFT: f32 = 54.0;
    const RIGHT: f32 = 54.0;
    const TOP: f32 = 56.0;
    const BOTTOM: f32 = 48.0;
    let mut pages = vec![Vec::new()];
    let mut bookmarks = Vec::new();
    let mut y = TOP;

    for item in flow {
        let font = pdf_metrics(fonts, item.font);
        let available_width = page_width - LEFT - RIGHT - item.indent;
        let lines = wrap_text(font, &item.text, item.size, available_width.max(72.0));
        if y + item.before + item.line_height > page_height - BOTTOM
            && !pages.last().is_some_and(Vec::is_empty)
        {
            pages.push(Vec::new());
            y = TOP;
        }
        y += item.before;
        if let Some(name) = item.bookmark.as_ref() {
            bookmarks.push(PdfBookmark {
                name: name.clone(),
                page_index: pages.len() - 1,
                y,
            });
        }
        for line in lines {
            if y + item.line_height > page_height - BOTTOM
                && !pages.last().is_some_and(Vec::is_empty)
            {
                pages.push(Vec::new());
                y = TOP;
            }
            pages
                .last_mut()
                .expect("PDF layout always has a page")
                .push(PdfPlacedLine {
                    text: line,
                    font: item.font,
                    size: item.size,
                    x: LEFT + item.indent,
                    y: y + item.size,
                    color: item.color,
                });
            y += item.line_height;
        }
        y += item.after;
    }

    if pages.len() > 1 {
        for lines in pages.iter_mut().skip(1) {
            lines.push(PdfPlacedLine {
                text: title.to_string(),
                font: PdfFontKind::Regular,
                size: 8.0,
                x: LEFT,
                y: 28.0,
                color: (0.45, 0.48, 0.55),
            });
        }
    }
    (pages, bookmarks)
}

fn add_pdf_footer(
    lines: &mut Vec<PdfPlacedLine>,
    fonts: &PdfFonts,
    page_width: f32,
    page_height: f32,
    page: usize,
    page_count: usize,
) {
    let text = format!("Candor | Page {page} of {page_count} | Local only");
    let width = pdf_text_width(pdf_metrics(fonts, PdfFontKind::Regular), &text, 8.0);
    lines.push(PdfPlacedLine {
        text,
        font: PdfFontKind::Regular,
        size: 8.0,
        x: ((page_width - width) / 2.0).max(36.0),
        y: page_height - 24.0,
        color: (0.45, 0.48, 0.55),
    });
}

fn pdf_font(fonts: &PdfFonts, kind: PdfFontKind) -> &Font {
    match kind {
        PdfFontKind::Regular => &fonts.regular,
        PdfFontKind::Bold => &fonts.bold,
    }
}

fn pdf_metrics(fonts: &PdfFonts, kind: PdfFontKind) -> &Face<'static> {
    match kind {
        PdfFontKind::Regular => &fonts.regular_metrics,
        PdfFontKind::Bold => &fonts.bold_metrics,
    }
}

fn pdf_text_width(font: &Face<'_>, text: &str, size: f32) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    let mut buffer = UnicodeBuffer::new();
    buffer.push_str(text);
    let glyphs = rustybuzz::shape(font, &[], buffer);
    let advance = glyphs
        .glyph_positions()
        .iter()
        .map(|position| position.x_advance as f32)
        .sum::<f32>();
    advance / font.units_per_em().max(1) as f32 * size
}

fn wrap_text(font: &Face<'_>, text: &str, size: f32, max_width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for source_line in text.lines() {
        if source_line.trim().is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current = String::new();
        for word in source_line.split_whitespace() {
            let candidate = if current.is_empty() {
                word.to_string()
            } else {
                format!("{current} {word}")
            };
            if pdf_text_width(font, &candidate, size) <= max_width {
                current = candidate;
                continue;
            }
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            if pdf_text_width(font, word, size) <= max_width {
                current.push_str(word);
            } else {
                for chunk in split_long_word(font, word, size, max_width) {
                    if current.is_empty() {
                        current = chunk;
                    } else {
                        lines.push(std::mem::replace(&mut current, chunk));
                    }
                }
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn split_long_word(font: &Face<'_>, word: &str, size: f32, max_width: f32) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in word.chars() {
        let mut candidate = current.clone();
        candidate.push(ch);
        if !current.is_empty() && pdf_text_width(font, &candidate, size) > max_width {
            chunks.push(std::mem::take(&mut current));
        }
        current.push(ch);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn markdown_blocks(markdown: &str) -> Vec<MarkdownBlock> {
    if markdown.trim().is_empty() {
        return Vec::new();
    }
    let mut options = MarkdownOptions::empty();
    options.insert(MarkdownOptions::ENABLE_TASKLISTS);
    options.insert(MarkdownOptions::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(markdown, options);
    let mut blocks = Vec::new();
    let mut list_stack = Vec::<bool>::new();
    let mut captures = Vec::<TextCapture>::new();

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => captures.push(TextCapture {
                kind: CaptureKind::Heading(heading_level(level)),
                text: String::new(),
                checked: None,
            }),
            Event::Start(Tag::Paragraph) => {
                if !matches!(
                    captures.last().map(|capture| &capture.kind),
                    Some(CaptureKind::Bullet { .. })
                ) {
                    captures.push(TextCapture {
                        kind: CaptureKind::Paragraph,
                        text: String::new(),
                        checked: None,
                    });
                }
            }
            Event::Start(Tag::List(start)) => list_stack.push(start.is_some()),
            Event::Start(Tag::Item) => captures.push(TextCapture {
                kind: CaptureKind::Bullet {
                    depth: list_stack.len().saturating_sub(1),
                    ordered: list_stack.last().copied().unwrap_or(false),
                },
                text: String::new(),
                checked: None,
            }),
            Event::Start(Tag::CodeBlock(_)) => captures.push(TextCapture {
                kind: CaptureKind::Code,
                text: String::new(),
                checked: None,
            }),
            Event::Text(text) | Event::Code(text) => append_capture_text(&mut captures, &text),
            Event::SoftBreak => append_capture_text(&mut captures, " "),
            Event::HardBreak => append_capture_text(&mut captures, "\n"),
            Event::TaskListMarker(checked) => {
                if let Some(capture) = captures
                    .iter_mut()
                    .rev()
                    .find(|capture| matches!(capture.kind, CaptureKind::Bullet { .. }))
                {
                    capture.checked = Some(checked);
                }
            }
            Event::Rule => blocks.push(MarkdownBlock::Rule),
            Event::End(TagEnd::Heading(_)) => finish_capture(&mut captures, &mut blocks),
            Event::End(TagEnd::Paragraph) => {
                if matches!(
                    captures.last().map(|capture| &capture.kind),
                    Some(CaptureKind::Paragraph)
                ) {
                    finish_capture(&mut captures, &mut blocks);
                }
            }
            Event::End(TagEnd::Item) => finish_capture(&mut captures, &mut blocks),
            Event::End(TagEnd::List(_)) => {
                list_stack.pop();
            }
            Event::End(TagEnd::CodeBlock) => finish_capture(&mut captures, &mut blocks),
            _ => {}
        }
    }
    while !captures.is_empty() {
        finish_capture(&mut captures, &mut blocks);
    }
    blocks
}

fn append_capture_text(captures: &mut [TextCapture], text: &str) {
    if let Some(capture) = captures.last_mut() {
        capture.text.push_str(text);
    }
}

fn finish_capture(captures: &mut Vec<TextCapture>, blocks: &mut Vec<MarkdownBlock>) {
    let Some(capture) = captures.pop() else {
        return;
    };
    let text = capture.text.trim().to_string();
    if text.is_empty() {
        return;
    }
    blocks.push(match capture.kind {
        CaptureKind::Heading(level) => MarkdownBlock::Heading { level, text },
        CaptureKind::Paragraph => MarkdownBlock::Paragraph(text),
        CaptureKind::Bullet { depth, ordered } => MarkdownBlock::Bullet {
            depth,
            ordered,
            checked: capture.checked,
            text,
        },
        CaptureKind::Code => MarkdownBlock::Code(text),
    });
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn split_paragraphs(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n")
        .split("\n\n")
        .map(|paragraph| paragraph.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|paragraph| !paragraph.is_empty())
        .collect()
}

fn report_metadata(report: &PreparedReport) -> String {
    let date = OffsetDateTime::from_unix_timestamp(
        (report.created_at_ms / 1000).min(i64::MAX as u128) as i64,
    )
    .map(|value| value.date().to_string())
    .unwrap_or_else(|_| "Date unavailable".to_string());
    format!(
        "{date} | {} | Stored and processed locally",
        format_duration(report.duration_ms)
    )
}

fn transcript_label(segment: &ReportTranscriptSegment, include_timestamps: bool) -> String {
    let channel = if segment.channel.trim().is_empty() {
        "audio"
    } else {
        segment.channel.trim()
    };
    let speaker = if segment.speaker.trim().is_empty() {
        "Speaker"
    } else {
        segment.speaker.trim()
    };
    if include_timestamps {
        let timestamp = if segment.end_ms > segment.start_ms {
            format!(
                "{}-{}",
                format_timestamp(segment.start_ms),
                format_timestamp(segment.end_ms)
            )
        } else {
            format_timestamp(segment.start_ms)
        };
        format!("[{timestamp}] {speaker} ({channel}): ")
    } else {
        format!("{speaker} ({channel}): ")
    }
}

fn report_item_source(item: &ExportReportItemInput, include_timestamps: bool) -> String {
    let speaker = item.speaker.trim();
    match (speaker.is_empty(), include_timestamps) {
        (true, false) => String::new(),
        (false, false) => speaker.to_string(),
        (true, true) => format_timestamp(item.start_ms),
        (false, true) => format!("{speaker} at {}", format_timestamp(item.start_ms)),
    }
}

fn value_or_not_set(value: &str) -> &str {
    if value.trim().is_empty() {
        "Not set"
    } else {
        value.trim()
    }
}

fn value_or_open(value: &str) -> &str {
    if value.trim().is_empty() {
        "Open"
    } else {
        value.trim()
    }
}

fn format_timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn format_duration(ms: u64) -> String {
    let value = format_timestamp(ms);
    format!("{value} duration")
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use lopdf::Document as LopdfDocument;
    use zip::ZipArchive;

    use super::*;

    fn fixture() -> PreparedReport {
        PreparedReport {
            title: "Product Strategy Sync".to_string(),
            created_at_ms: 1_753_000_000_000,
            duration_ms: 3_661_000,
            report: ExportReportInput {
                summary:
                    "The team approved the local platform refresh and kept evidence links visible."
                        .to_string(),
                decisions: vec![ExportReportItemInput {
                    text: "Use the encrypted local vault for all meeting data.".to_string(),
                    speaker: "Alex".to_string(),
                    start_ms: 135_000,
                    ..Default::default()
                }],
                actions: vec![ExportReportItemInput {
                    text: "Draft the offline export proof.".to_string(),
                    speaker: "Priya".to_string(),
                    start_ms: 550_000,
                    owner: "Priya".to_string(),
                    due_date: "2026-07-15".to_string(),
                    status: "Open".to_string(),
                }],
                risks: vec![ExportReportItemInput {
                    text: "Unsigned installers remain a release risk.".to_string(),
                    speaker: "Lee".to_string(),
                    start_ms: 610_000,
                    ..Default::default()
                }],
                questions: vec![ExportReportItemInput {
                    text: "When will the macOS runner be available?".to_string(),
                    speaker: "Diego".to_string(),
                    start_ms: 720_000,
                    ..Default::default()
                }],
            },
            options: ExportDocumentOptions::default(),
            notes_markdown: "## Notes\n\n- [x] Keep this local\n- Verify **Word** and PDF output."
                .to_string(),
            transcript: vec![ReportTranscriptSegment {
                speaker: "Alex".to_string(),
                channel: "mic".to_string(),
                text: "Здравствуйте. Reliability is our moat.".to_string(),
                start_ms: 135_000,
                end_ms: 139_000,
            }],
        }
    }

    #[test]
    fn markdown_notes_are_structured() {
        let blocks = markdown_blocks("## Decisions\n\n- [x] Keep it local\n\nPlain **text**.");
        assert_eq!(
            blocks,
            vec![
                MarkdownBlock::Heading {
                    level: 2,
                    text: "Decisions".to_string(),
                },
                MarkdownBlock::Bullet {
                    depth: 0,
                    ordered: false,
                    checked: Some(true),
                    text: "Keep it local".to_string(),
                },
                MarkdownBlock::Paragraph("Plain text.".to_string()),
            ]
        );
    }

    #[test]
    fn word_export_is_native_openxml_with_table_and_page_fields() {
        let rendered = render_docx(&fixture()).expect("render docx");
        assert!(rendered.bytes.starts_with(b"PK"));
        let mut archive = ZipArchive::new(Cursor::new(rendered.bytes)).expect("open docx zip");
        let mut document_xml = String::new();
        archive
            .by_name("word/document.xml")
            .expect("document xml")
            .read_to_string(&mut document_xml)
            .expect("read document xml");
        assert!(document_xml.contains("Product Strategy Sync"));
        assert!(document_xml.contains("Action item"));
        assert!(document_xml.contains("<w:tbl>"));
        assert!(document_xml.contains("<w:numPr>"));
        drop(document_xml);
        let mut footer_xml = String::new();
        archive
            .by_name("word/footer1.xml")
            .expect("footer xml")
            .read_to_string(&mut footer_xml)
            .expect("read footer xml");
        assert!(footer_xml.contains("PAGE"));
        assert!(footer_xml.contains("NUMPAGES"));
    }

    #[test]
    fn pdf_export_is_searchable_unicode_and_bookmarked() {
        let rendered = render_pdf(&fixture()).expect("render pdf");
        assert!(rendered.bytes.starts_with(b"%PDF-"));
        assert!(rendered.page_count >= 1);
        let parsed = LopdfDocument::load_mem(&rendered.bytes).expect("parse generated pdf");
        let pages = parsed.get_pages().keys().copied().collect::<Vec<_>>();
        let text = parsed
            .extract_text(&pages)
            .expect("extract generated PDF text");
        assert!(text.contains("Product Strategy Sync"));
        assert!(text.contains("Здравствуйте"));
        assert!(text.contains("Draft the offline export proof"));
        assert!(parsed
            .catalog()
            .expect("PDF catalog")
            .get(b"Outlines")
            .is_ok());
    }

    #[test]
    fn report_validation_rejects_control_characters() {
        let mut report = fixture();
        report.report.summary = "unsafe\0summary".to_string();
        assert!(report
            .validate()
            .unwrap_err()
            .contains("control characters"));
    }
}
