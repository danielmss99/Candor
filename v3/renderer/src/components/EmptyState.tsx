interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <section className="empty-state-panel" aria-label={title}>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {actionLabel && onAction ? (
        <button type="button" className="secondary-button" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </section>
  );
}
