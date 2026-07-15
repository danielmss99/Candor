import { ArrowLeft, FileOutput } from "lucide-react";
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
      <header className="screen-heading export-heading">
        <div className="heading-with-back">
          <button className="icon-button" type="button" onClick={props.onBack} aria-label="Back to review" title="Back to review"><ArrowLeft size={17} aria-hidden="true" /></button>
          <div><h1>Export report</h1><p>{props.title}</p></div>
        </div>
        <button type="button" className="primary-button" data-export-save onClick={props.onSave} disabled={!props.canExport || props.saving}><FileOutput size={16} aria-hidden="true" />{props.saving ? "Saving..." : exportActionLabel(props.format)}</button>
      </header>
      <div className="export-dialog-surface">
        <aside className="export-options" aria-label="Export options">
          <header><h2>Format</h2><p>{exportFormatLabel(props.format)} report</p></header>
          <fieldset><legend>Format</legend><div className="format-options"><button type="button" aria-pressed={props.format === "docx"} onClick={() => props.onFormatChange("docx")}>Word (.docx)<small>Editable</small></button><button type="button" aria-pressed={props.format === "pdf"} onClick={() => props.onFormatChange("pdf")}>PDF<small>Searchable</small></button><button type="button" aria-pressed={props.format === "markdown"} onClick={() => props.onFormatChange("markdown")}>Markdown<small>Plain text</small></button></div></fieldset>
          <details className="export-customize">
            <summary>Customize report</summary>
            <fieldset><legend>Paper size</legend><div className="segmented-control paper-size-control" role="group" aria-label="Paper size"><button type="button" aria-pressed={props.paperSize === "letter"} onClick={() => props.onPaperSizeChange("letter")}>Letter</button><button type="button" aria-pressed={props.paperSize === "a4"} onClick={() => props.onPaperSizeChange("a4")}>A4</button></div></fieldset>
            <fieldset><legend>Include sections</legend><label><input type="checkbox" checked={props.sections.summary} onChange={() => props.onToggleSection("summary")} /> Executive summary</label><label><input type="checkbox" checked={props.sections.decisions} onChange={() => props.onToggleSection("decisions")} /> Decisions</label><label><input type="checkbox" checked={props.sections.actions} onChange={() => props.onToggleSection("actions")} /> Action items</label><label><input type="checkbox" checked={props.sections.risks} onChange={() => props.onToggleSection("risks")} /> Risks</label><label><input type="checkbox" checked={props.sections.questions} onChange={() => props.onToggleSection("questions")} /> Open questions</label><label><input type="checkbox" checked={props.sections.notes} onChange={() => props.onToggleSection("notes")} /> Manual notes</label><label><input type="checkbox" checked={props.sections.transcript} onChange={() => props.onToggleSection("transcript")} /> Full transcript</label><label><input type="checkbox" checked={props.sections.timestamps} onChange={() => props.onToggleSection("timestamps")} /> Audio timestamps</label></fieldset>
          </details>
        </aside>
        <div className="export-preview-wrap"><div className="export-preview-heading"><strong>Report preview</strong><span>{exportFormatLabel(props.format)} / {props.paperSize === "letter" ? "Letter" : "A4"} / Local</span></div><DocumentPreview title={props.title} summary={props.summary} decisions={props.decisions} actions={props.actions} risks={props.risks} questions={props.questions} includeSummary={props.sections.summary} includeNotes={props.sections.notes} includeTranscript={props.sections.transcript} /></div>
      </div>
      {props.format === "markdown" && props.markdownExport ? <details className="markdown-output"><summary>Saved Markdown</summary><pre>{props.markdownExport}</pre></details> : null}
    </section>
  );
}
