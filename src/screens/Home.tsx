import { useEffect, useState } from "react";
import type { CalendarEvent, View } from "../App";
import { Avatar } from "../components/Avatar";
import { Sidebar } from "../components/Sidebar";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { OnboardingChecklist } from "../components/OnboardingChecklist";
import type { CompletedAction, UserTask } from "../api/actions";
import { loadSavedMeetings, type SavedMeeting } from "../api/local";
import { useUser } from "../user";
import { fmtEventTime } from "../format";
import { actionItems, mockSavedMeetings, people } from "../data/mock";
import { meetingContextHandler } from "../components/ContextMenu";
import type { ContextMenuState } from "../meetingEdit";
import { buildCatchUpDigest } from "../v2/catchUp";
import { loadFavorites, type OnboardingState } from "../v2/metadata";

interface HomeProps {
  onNavigate: (view: View) => void;
  onStartRecording: () => void;
  onOpenMeeting: (id: string) => void;
  calendarConnected: boolean;
  events: CalendarEvent[];
  onConnectCalendar: () => void;
  onRecordEvent: (ev: CalendarEvent) => void;
  completedIds: Set<string>;
  onCompleteAction: (item: Omit<CompletedAction, "completedAt">) => void;
  onMeetingContextMenu: (x: number, y: number, target: ContextMenuState["target"]) => void;
  userTasks: UserTask[];
  meetingsRefreshKey: number;
  onboarding: OnboardingState;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Home({
  onNavigate,
  onStartRecording,
  onOpenMeeting,
  calendarConnected,
  events,
  onConnectCalendar,
  onRecordEvent,
  completedIds,
  onCompleteAction,
  onMeetingContextMenu,
  userTasks,
  meetingsRefreshKey,
  onboarding,
}: HomeProps) {
  const { firstName } = useUser();
  const [savedMeetings, setSavedMeetings] = useState<SavedMeeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [favorites] = useState(() => loadFavorites());

  useEffect(() => {
    let cancelled = false;
    setMeetingsLoading(true);
    loadSavedMeetings().then((m) => {
      if (!cancelled) {
        setSavedMeetings(m);
        setMeetingsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [meetingsRefreshKey]);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const mockOpen = actionItems.filter((a) => !completedIds.has(a.id));
  const userOpen = userTasks.filter((a) => !completedIds.has(a.id));
  const openActions = [...userOpen, ...mockOpen];
  const displayMeetings = savedMeetings.length > 0 ? savedMeetings : mockSavedMeetings();
  const recent = displayMeetings.slice(0, 3);
  const pinned = displayMeetings.filter((m) => favorites.has(m.id)).slice(0, 2);
  const digest = buildCatchUpDigest(displayMeetings, userTasks, completedIds, [], mockOpen);

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="Home" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <OnboardingChecklist
          state={onboarding}
          onConnectCalendar={onConnectCalendar}
          onStartRecording={onStartRecording}
          onOpenMeetings={() => onNavigate("library")}
          onOpenTasks={() => onNavigate("actions")}
        />

        <div className="home-hero">
          <div>
            <div className="home-greeting">
              {greeting()}, {firstName}
            </div>
            <div className="home-date">{today}</div>
          </div>
          <div className="spacer" />
          <button className="btn-record" onClick={onStartRecording}>
            <span className="rec-dot" />
            Start recording
          </button>
        </div>

        <section className="upcoming">
          <div className="home-col-head">
            <span className="section-label section-label--calm">Upcoming meetings</span>
            {calendarConnected && (
              <button className="link-btn" onClick={onConnectCalendar}>
                Calendar settings
              </button>
            )}
          </div>

          {!calendarConnected ? (
            <button className="connect-card" onClick={onConnectCalendar}>
              <div>
                <div className="connect-title">Connect your calendar</div>
                <div className="connect-desc">
                  Pull in your Outlook, Google, or Apple meetings — ready to record in one click.
                </div>
              </div>
              <span className="connect-cta">Connect →</span>
            </button>
          ) : events.length === 0 ? (
            <div className="home-empty">No meetings in the next two weeks.</div>
          ) : (
            events.slice(0, 6).map((ev) => (
              <div
                key={ev.id}
                className="event-card event-card--menu"
                onContextMenu={(e) =>
                  meetingContextHandler(e, (x, y) =>
                    onMeetingContextMenu(x, y, { kind: "calendar", event: ev }),
                  )
                }
              >
                <div className="event-main">
                  <span className="event-title">{ev.title}</span>
                  <span className="event-time">
                    {fmtEventTime(ev.start)}
                    {ev.attendees.length > 0 && ` · ${ev.attendees.length} people`}
                    {ev.onlineUrl && " · online"}
                  </span>
                </div>
                <button className="btn-record-sm" onClick={() => onRecordEvent(ev)}>
                  <span className="rec-dot" />
                  Record
                </button>
              </div>
            ))
          )}
        </section>

        <section className="catch-up-digest">
          <div className="home-col-head">
            <span className="section-label section-label--calm">Catch up · last 7 days</span>
          </div>
          <div className="catch-up-card">
            <p className="catch-up-meta">
              {digest.meetingCount} meeting{digest.meetingCount === 1 ? "" : "s"} ·{" "}
              {digest.openTasks.length} open task{digest.openTasks.length === 1 ? "" : "s"}
            </p>
            {digest.decisions.length > 0 && (
              <ul className="catch-up-list">
                {digest.decisions.slice(0, 3).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {digest.openTasks.length > 0 && (
              <div className="catch-up-tasks">
                {digest.openTasks.slice(0, 3).map((t, i) => (
                  <div key={i} className="catch-up-task">
                    <span>{t.text}</span>
                    <span className="catch-up-due">{t.due}</span>
                  </div>
                ))}
              </div>
            )}
            {digest.meetingCount === 0 && digest.openTasks.length === 0 && (
              <div className="home-empty">Quiet week — you're caught up.</div>
            )}
          </div>
        </section>

        <div className="home-stats">
          <button className="stat-card" onClick={() => onNavigate("library")}>
            <span className="stat-num">{displayMeetings.length}</span>
            <span className="stat-label">Meetings</span>
          </button>
          <button className="stat-card" onClick={() => onNavigate("actions")}>
            <span className="stat-num">{openActions.length}</span>
            <span className="stat-label">Open tasks</span>
          </button>
        </div>

        <div className="home-cols">
          <section className="home-col">
            <div className="home-col-head">
              <span className="section-label section-label--calm">Recent meetings</span>
              <button className="link-btn" onClick={() => onNavigate("library")}>
                View all
              </button>
            </div>
            {meetingsLoading ? (
              <Skeleton rows={3} />
            ) : recent.length === 0 ? (
              <EmptyState
                icon="🎙"
                title="No recordings yet"
                description="Start your first meeting to see recaps and tasks here."
                primaryAction={{ label: "Start recording", onClick: onStartRecording }}
              />
            ) : (
              <>
                {pinned.map((m) => (
                  <button
                    key={m.id}
                    className="home-card home-card--menu"
                    onClick={() => onOpenMeeting(m.id)}
                  >
                    <div className="home-card-main">
                      <span className="home-card-title">★ {m.title}</span>
                      <span className="home-card-sub">{m.whenLabel}</span>
                    </div>
                  </button>
                ))}
                {recent.map((m) => (
                <button
                  key={m.id}
                  className="home-card home-card--menu"
                  onClick={() => onOpenMeeting(m.id)}
                  onContextMenu={(e) =>
                    meetingContextHandler(e, (x, y) =>
                      onMeetingContextMenu(x, y, { kind: "saved", meeting: m }),
                    )
                  }
                >
                  <div className="home-card-main">
                    <span className="home-card-title">{m.title}</span>
                    <span className="home-card-sub">{m.whenLabel}</span>
                  </div>
                </button>
                ))}
              </>
            )}
          </section>

          <section className="home-col">
            <div className="home-col-head">
              <span className="section-label section-label--calm">Your tasks</span>
              <button className="link-btn" onClick={() => onNavigate("actions")}>
                View all
              </button>
            </div>
            {openActions.slice(0, 4).map((a) => (
              <div key={a.id} className="home-card home-card--action">
                <button
                  type="button"
                  className="home-action-check"
                  onClick={() =>
                    onCompleteAction({
                      id: a.id,
                      text: a.text,
                      owner: a.owner,
                      due: a.due,
                      meeting: a.meeting,
                      meetingId: "meetingId" in a ? a.meetingId : undefined,
                      soon: a.soon,
                    })
                  }
                  aria-label="Mark done"
                />
                <span className="home-action-task">{a.text}</span>
                <Avatar
                  {...(a.owner in people
                    ? { who: a.owner as keyof typeof people }
                    : {
                        label: a.owner.slice(0, 2).toUpperCase(),
                        bg: "var(--coral)",
                        fg: "var(--coral-on)",
                      })}
                  size={20}
                />
              </div>
            ))}
            {openActions.length === 0 && (
              <div className="home-empty">All caught up — nothing open.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
