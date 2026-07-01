import { useCallback, useState } from "react";
import type { SidebarFolderProps, View } from "../App";
import { Sidebar } from "../components/Sidebar";
import { loadDictionary, saveDictionary } from "../v2/dictionary";

interface DictionaryProps {
  onNavigate: (view: View) => void;
  sidebarFolder: SidebarFolderProps;
  embedded?: boolean;
}

export function Dictionary({ onNavigate, sidebarFolder, embedded }: DictionaryProps) {
  const [words, setWords] = useState<string[]>(() => loadDictionary());
  const [draft, setDraft] = useState("");

  const persist = useCallback((next: string[]) => {
    setWords(next);
    saveDictionary(next);
  }, []);

  const addWord = () => {
    const word = draft.trim();
    if (!word || words.some((w) => w.toLowerCase() === word.toLowerCase())) return;
    persist([...words, word]);
    setDraft("");
  };

  const removeWord = (word: string) => {
    persist(words.filter((w) => w !== word));
  };

  const content = (
    <>
      <div className="dict-header">
        <h1 className="dict-title">Dictionary</h1>
        <p className="dict-desc">
          Add names, jargon, and product terms. Candor passes these to Whisper as a prompt hint
          during transcription and uses them for future find-and-replace.
        </p>
      </div>

      <form
        className="dict-add-row"
        onSubmit={(e) => {
          e.preventDefault();
          addWord();
        }}
      >
        <input
          className="dict-input"
          type="text"
          placeholder="e.g. Candor, pyannote, Kubernetes…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="New dictionary word"
        />
        <button type="submit" className="btn-primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {words.length === 0 ? (
        <div className="dict-empty">No custom words yet — add terms you want recognized accurately.</div>
      ) : (
        <ul className="dict-list">
          {words.map((word) => (
            <li key={word} className="dict-chip">
              <span>{word}</span>
              <button
                type="button"
                className="dict-chip-remove"
                onClick={() => removeWord(word)}
                aria-label={`Remove ${word}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <details className="dict-research">
        <summary>Help Candor hear your team's words</summary>
        <p>
          Add the names, acronyms, tools, clients, and product terms your team says every day.
          Candor uses this list as a hint during transcription, so uncommon words are more likely
          to show up the way you expect. It is not a guarantee, but it gives Whisper better context
          before it turns your meeting audio into notes.
        </p>
      </details>
    </>
  );

  if (embedded) return content;

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Dictionary" onNavigate={onNavigate} {...sidebarFolder} />
      <div className="main main--scroll dict-screen">{content}</div>
    </div>
  );
}
