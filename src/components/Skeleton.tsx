interface SkeletonProps {
  rows?: number;
  variant?: "list" | "card" | "recap";
}

export function Skeleton({ rows = 4, variant = "list" }: SkeletonProps) {
  if (variant === "recap") {
    return (
      <div className="skeleton-block" aria-hidden="true">
        <div className="skeleton-line skeleton-line--lg" />
        <div className="skeleton-line skeleton-line--full" />
        <div className="skeleton-line skeleton-line--full" />
        <div className="skeleton-line skeleton-line--md" />
      </div>
    );
  }
  return (
    <div className="skeleton-list" aria-hidden="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`skeleton-row ${variant === "card" ? "skeleton-row--card" : ""}`}>
          <div className="skeleton-line skeleton-line--title" />
          <div className="skeleton-line skeleton-line--sub" />
        </div>
      ))}
    </div>
  );
}
