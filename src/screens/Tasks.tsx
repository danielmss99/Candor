import { useState } from "react";
import type { View } from "../App";
import { Avatar } from "../components/Avatar";
import { Sidebar } from "../components/Sidebar";
import type { CompletedAction, UserTask } from "../api/actions";
import { actionItems, people, type ActionItem } from "../data/mock";
import { useUser } from "../user";

type Filter = "Open" | "Done" | "All";
const FILTERS: Filter[] = ["Open", "Done", "All"];

type OpenItem = ActionItem | UserTask;

interface TasksProps {
  onNavigate: (view: View) => void;
  completedIds: Set<string>;
  completedActions: CompletedAction[];
  onCompleteAction: (item: Omit<CompletedAction, "completedAt">) => void;
  onUncompleteAction: (id: string) => void;
  userTasks: UserTask[];
  onAddTask: (params: { text: string; owner: string; dueDate?: string; meeting?: string }) => void;
}

function ownerAvatar(owner: string) {
  if (owner in people) {
    return { who: owner as keyof typeof people };
  }
  return { label: owner.slice(0, 2).toUpperCase(), bg: "var(--coral)", fg: "var(--coral-on)" };
}

function toCompleted(item: OpenItem): Omit<CompletedAction, "completedAt"> {
  return {
    id: item.id,
    text: item.text,
    owner: item.owner,
    due: item.due,
    meeting: item.meeting,
    soon: item.soon,
  };
}

function openItemSortKey(item: OpenItem): string {
  if ("createdAt" in item) return item.createdAt;
  return item.id;
}

function emptyMessage(filter: Filter): { title: string; hint: string } {
  if (filter === "Done") {
    return {
      title: "No completed tasks yet",
      hint: "Check off an open task to track your progress here.",
    };
  }
  if (filter === "Open") {
    return {
      title: "All caught up",
      hint: "Add a task above or complete items from your meeting recaps.",
    };
  }
  return {
    title: "No tasks yet",
    hint: "Create your first task using the form above.",
  };
}

export function Tasks({
  onNavigate,
  completedIds,
  completedActions,
  onCompleteAction,
  onUncompleteAction,
  userTasks,
  onAddTask,
}: TasksProps) {
  const { initials } = useUser();
  const [filter, setFilter] = useState<Filter>("Open");
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState(initials);
  const [dueDate, setDueDate] = useState("");
  const [meeting, setMeeting] = useState("");
  const [showDetails, setShowDetails] = useState(false);

  const mockOpen = actionItems.filter((a) => !completedIds.has(a.id));
  const userOpen = userTasks.filter((a) => !completedIds.has(a.id));
  const openItems: OpenItem[] = [...userOpen, ...mockOpen].sort((a, b) =>
    openItemSortKey(b).localeCompare(openItemSortKey(a)),
  );
  const openCount = openItems.length;
  const doneCount = completedActions.length;

  const recapOnlyDone = completedActions.filter(
    (a) => !actionItems.some((m) => m.id === a.id),
  );

  const items: Array<
    | { kind: "open"; item: OpenItem }
    | { kind: "done"; item: CompletedAction }
  > = (() => {
    if (filter === "Open") {
      return openItems.map((item) => ({ kind: "open" as const, item }));
    }
    if (filter === "Done") {
      const fromMock = actionItems
        .filter((a) => completedIds.has(a.id))
        .map((a) => completedActions.find((c) => c.id === a.id)!)
        .filter(Boolean);
      const done = [...fromMock, ...recapOnlyDone];
      done.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      return done.map((item) => ({ kind: "done" as const, item }));
    }
    const open = openItems.map((item) => ({ kind: "open" as const, item }));
    const done = completedActions
      .slice()
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .map((item) => ({ kind: "done" as const, item }));
    return [...open, ...done];
  })();

  const filterCount = (f: Filter) => {
    if (f === "Open") return openCount;
    if (f === "Done") return doneCount;
    return openCount + doneCount;
  };

  const submitTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onAddTask({
      text: title,
      owner,
      dueDate: dueDate || undefined,
      meeting: meeting || undefined,
    });
    setTitle("");
    setDueDate("");
    setMeeting("");
    setShowDetails(false);
  };

  const ownerOptions = [
    { value: initials, label: `Me (${initials})` },
    ...Object.entries(people).map(([key, p]) => ({ value: key, label: p.name })),
  ];

  const empty = emptyMessage(filter);

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Tasks" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <div className="library-head tasks-head">
          <div>
            <span className="page-title">Tasks</span>
            <p className="tasks-lead">Follow-ups from meetings and your own to-dos</p>
          </div>
          <div className="spacer" />
          {openCount > 0 && (
            <span className="tasks-open-badge">{openCount} open</span>
          )}
        </div>

        <form className="tasks-add-card" onSubmit={submitTask}>
          <span className="section-label section-label--spaced">NEW TASK</span>
          <div className="tasks-add-main">
            <input
              className="tasks-add-input"
              placeholder="What needs to get done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Task title"
            />
            <button type="submit" className="btn-primary" disabled={!title.trim()}>
              Add task
            </button>
          </div>
          {!showDetails ? (
            <button
              type="button"
              className="tasks-details-toggle"
              onClick={() => setShowDetails(true)}
            >
              + Assignee, due date, meeting
            </button>
          ) : (
            <div className="tasks-add-meta">
              <label className="tasks-field">
                <span className="tasks-field-label">Assignee</span>
                <select
                  className="people-input"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  aria-label="Assignee"
                >
                  {ownerOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tasks-field">
                <span className="tasks-field-label">Due date</span>
                <input
                  type="date"
                  className="people-input"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  aria-label="Due date"
                />
              </label>
              <label className="tasks-field tasks-field--wide">
                <span className="tasks-field-label">Meeting</span>
                <input
                  className="people-input"
                  placeholder="Optional"
                  value={meeting}
                  onChange={(e) => setMeeting(e.target.value)}
                  aria-label="Meeting"
                />
              </label>
            </div>
          )}
        </form>

        <div className="tasks-filter-row">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`chip ${filter === f ? "chip--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f}
              <span className="tasks-filter-count">{filterCount(f)}</span>
            </button>
          ))}
        </div>

        <div className="tasks-list">
          {items.map((row) => {
            if (row.kind === "open") {
              const a = row.item;
              const avatar =
                a.owner in people
                  ? { who: a.owner as keyof typeof people }
                  : ownerAvatar(a.owner);
              return (
                <div key={a.id} className="task-row">
                  <button
                    type="button"
                    className="task-check"
                    onClick={() => onCompleteAction(toCompleted(a))}
                    aria-label="Mark done"
                  />
                  <div className="task-body">
                    <span className="task-text">{a.text}</span>
                    {a.meeting && <span className="task-meeting">{a.meeting}</span>}
                  </div>
                  <Avatar {...avatar} size={22} />
                  {a.due && (
                    <span className={`due-pill ${a.soon ? "due-pill--soon" : ""}`}>{a.due}</span>
                  )}
                </div>
              );
            }
            const a = row.item;
            return (
              <div key={a.id} className="task-row task-row--done">
                <button
                  type="button"
                  className="task-check task-check--done"
                  onClick={() => onUncompleteAction(a.id)}
                  aria-label="Mark not done"
                >
                  ✓
                </button>
                <div className="task-body">
                  <span className="task-text task-text--done">{a.text}</span>
                  {a.meeting && <span className="task-meeting">{a.meeting}</span>}
                </div>
                <Avatar {...ownerAvatar(a.owner)} size={22} />
                {a.due && <span className="due-pill">{a.due}</span>}
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="tasks-empty">
              <span className="tasks-empty-icon" aria-hidden="true">
                ✓
              </span>
              <p className="tasks-empty-title">{empty.title}</p>
              <p className="tasks-empty-hint">{empty.hint}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
