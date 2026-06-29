interface KeywordCloudProps {
  terms: { word: string; weight: number }[];
  onSelect?: (word: string) => void;
}

export function KeywordCloud({ terms, onSelect }: KeywordCloudProps) {
  if (terms.length === 0) return null;
  const max = Math.max(...terms.map((t) => t.weight), 1);

  return (
    <div className="keyword-cloud">
      <span className="section-label section-label--calm">Top terms</span>
      <div className="keyword-cloud-tags">
        {terms.map((t) => {
          const scale = 0.85 + (t.weight / max) * 0.35;
          return (
            <button
              key={t.word}
              type="button"
              className="keyword-tag"
              style={{ fontSize: `${scale}rem` }}
              onClick={() => onSelect?.(t.word)}
            >
              {t.word}
            </button>
          );
        })}
      </div>
    </div>
  );
}
