import { DocumentPreview } from "./DocumentPreview";
import { exportActionLabel, exportFormatLabel, type ExportFormat, type ExportPaperSize, type RecapItem } from "../../core/contracts";

export interface ExportSectionState {
  summary: boolean;
  decisions: boolean;
  actions: boolean;
  risks: boolean;
  questions: boolean;
  notes: boolean;
  transcript: boolean;
  timestamps: boolean;
}

interface ExportViewProps {
  title: string;
  summary: string;
  format: ExportFormat;
  paperSize: ExportPaperSize;
  sections: ExportSectionState;
  decisions: RecapItem[];
  actions: RecapItem[];
  risks: RecapItem[];
  questions: RecapItem[];
  markdownExport: string;
  canExport: boolean;
  saving: boolean;
  onFormatChange: (format: ExportFormat) => void;
  onPaperSizeChange: (size: ExportPaperSize) => void;
  onToggleSection: (section: keyof ExportSectionState) => void;
  onBack: () => void;
  onSave: () => void;
}

export function ExportView(props: ExportViewProps) {
  return (
    <section className="page-view export-view" data-view="export">
      <header className="screen-heading"><h1>Export Meeting</h1><p>Prepare a report without sending data off this device.</p></header>
      <div className="export-dialog-surface">
        <div className="export-options">
          <header><h2>Export meeting</h2><p>Current local renderer: {exportFormatLabel(props.format)}</p></header>
          <fieldset><legend>Format</legend><div className="format-options"><button type="button" aria-pressed={props.format === "docx"} onClick={() => props.onFormatChange("docx")}>Word (.docx)<small>Editable</small></button><button type="button" aria-pressed={props.format === "pdf"} onClick={() => props.onFormatChange("pdf")}>PDF<small>Searchable</small></button><button type="button" aria-pressed={props.format === "markdown"} onClick={() => props.onFormatChange("markdown")}>Markdown<small>Plain text</small></button></div></fieldset>
          <fieldset><legend>Paper size</legend><div className="segmented-control paper-size-control" role="group" aria-label="Paper size"><button type="button" aria-pressed={props.paperSize === "letter"} onClick={() => props.onPaperSizeChange("letter")}>Letter</button><button type="button" aria-pressed={props.paperSize === "a4"} onClick={() => props.onPaperSizeChange("a4")}>A4</button></div></fieldset>
          <fieldset><legend>Include sections</legend><label><input type="checkbox" checked={props.sections.summary} onChange={() => props.onToggleSection("summary")} /> Executive summary</label><label><input type="checkbox" checked={props.sections.decisions} onChange={() => props.onToggleSection("decisions")} /> Decisions</label><label><input type="checkbox" checked={props.sections.actions} onChange={() => props.onToggleSection("actions")} /> Action items</label><label><input type="checkbox" checked={props.sections.risks} onChange={() => props.onToggleSection("risks")} /> Risks</label><label><input type="checkbox" checked={props.sections.questions} onChange={() => props.onToggleSection("questions")} /> Open questions</label><label><input type="checkbox" checked={props.sections.notes} onChange={() => props.onToggleSection("notes")} /> Manual notes</label><label><input type="checkbox" checked={props.sections.transcript} onChange={() => props.onToggleSection("transcript")} /> Full transcript</label><label><input type="checkbox" checked={props.sections.timestamps} onChange={() => props.onToggleSection("timestamps")} /> Audio timestamps</label></fieldset>
          <div className="export-actions"><button type="button" className="secondary-button" onClick={props.onBack}>Back to review</button><button type="button" className="primary-button" data-export-save onClick={props.onSave} disabled={!props.canExport || props.saving}>{props.saving ? "Saving..." : exportActionLabel(props.format)}</button></div>
        </div>
        <div className="export-preview-wrap"><div className="export-preview-heading"><strong>Report preview</strong><span>{exportFormatLabel(props.format)} / {props.paperSize === "letter" ? "Letter" : "A4"} / Local</span></div><DocumentPreview title={props.title} summary={props.summary} decisions={props.decisions} actions={props.actions} risks={props.risks} questions={props.questions} includeSummary={props.sections.summary} includeNotes={props.sections.notes} includeTranscript={props.sections.transcript} /></div>
      </div>
      {props.format === "markdown" && props.markdownExport ? <details className="markdown-output"><summary>Saved Markdown</summary><pre>{props.markdownExport}</pre></details> : null}
    </section>
  );
}
