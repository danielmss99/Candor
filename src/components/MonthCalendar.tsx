import { useMemo, useState } from "react";
import type { CalendarEvent } from "../App";
import type { SavedMeeting } from "../api/local";
import { localeWeekStart, parseIsoLocalDate, toDateKey } from "../utils/time";

interface DayMarkers {
  calendar: number;
  recorded: number;
}

interface MonthCalendarProps {
  events: CalendarEvent[];
  savedMeetings: SavedMeeting[];
  selectedDay: string | null;
  onSelectDay: (dateKey: string | null) => void;
}

function weekdayLabels(weekStart: number): string[] {
  const labels: string[] = [];
  for (let i = 0; i < 7; i++) {
    const jsDay = (weekStart + i) % 7;
    const date = new Date(2024, 0, 7 + jsDay);
    labels.push(date.toLocaleDateString(undefined, { weekday: "narrow" }));
  }
  return labels;
}

function buildMonthCells(year: number, month: number, weekStart: number) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let padStart = first.getDay() - weekStart;
  if (padStart < 0) padStart += 7;

  const totalCells = Math.ceil((padStart + daysInMonth) / 7) * 7;
  const cells: { date: Date; inMonth: boolean }[] = [];

  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - padStart + 1;
    const date = new Date(year, month, dayNum);
    cells.push({ date, inMonth: dayNum >= 1 && dayNum <= daysInMonth });
  }

  return cells;
}

function countMeetingsByDay(
  events: CalendarEvent[],
  savedMeetings: SavedMeeting[],
): Map<string, DayMarkers> {
  const map = new Map<string, DayMarkers>();

  for (const ev of events) {
    const d = parseIsoLocalDate(ev.start);
    if (!d) continue;
    const key = toDateKey(d);
    const entry = map.get(key) ?? { calendar: 0, recorded: 0 };
    entry.calendar += 1;
    map.set(key, entry);
  }

  for (const m of savedMeetings) {
    const d = parseIsoLocalDate(m.date);
    if (!d) continue;
    const key = toDateKey(d);
    const entry = map.get(key) ?? { calendar: 0, recorded: 0 };
    entry.recorded += 1;
    map.set(key, entry);
  }

  return map;
}

export function MonthCalendar({
  events,
  savedMeetings,
  selectedDay,
  onSelectDay,
}: MonthCalendarProps) {
  const today = new Date();
  const todayKey = toDateKey(today);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  const weekStart = localeWeekStart();
  const weekdays = useMemo(() => weekdayLabels(weekStart), [weekStart]);
  const cells = useMemo(
    () => buildMonthCells(viewYear, viewMonth, weekStart),
    [viewYear, viewMonth, weekStart],
  );
  const meetingDays = useMemo(
    () => countMeetingsByDay(events, savedMeetings),
    [events, savedMeetings],
  );

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const shiftMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    onSelectDay(todayKey);
  };

  const handleDayClick = (key: string) => {
    onSelectDay(selectedDay === key ? null : key);
  };

  return (
    <section className="home-calendar home-calendar--polished" aria-label="Meeting calendar">
      <div className="home-calendar-head">
        <span className="section-label section-label--calm">Calendar</span>
        <div className="home-calendar-nav">
          <button
            type="button"
            className="home-calendar-today-btn"
            onClick={goToday}
          >
            Today
          </button>
          <button
            type="button"
            className="home-calendar-nav-btn"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="home-calendar-month">{monthLabel}</span>
          <button
            type="button"
            className="home-calendar-nav-btn"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <div className="home-calendar-grid" role="grid" aria-label={monthLabel}>
        {weekdays.map((label) => (
          <div key={label} className="home-calendar-weekday" role="columnheader">
            {label}
          </div>
        ))}
        {cells.map(({ date, inMonth }) => {
          const key = toDateKey(date);
          const markers = meetingDays.get(key);
          const hasCalendar = (markers?.calendar ?? 0) > 0;
          const hasRecorded = (markers?.recorded ?? 0) > 0;
          const isToday = key === todayKey;
          const isSelected = key === selectedDay;

          return (
            <button
              key={key + (inMonth ? "" : "-pad")}
              type="button"
              role="gridcell"
              className={[
                "home-calendar-day",
                !inMonth && "home-calendar-day--muted",
                isToday && "home-calendar-day--today",
                isSelected && "home-calendar-day--selected",
                (hasCalendar || hasRecorded) && "home-calendar-day--has-meetings",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => inMonth && handleDayClick(key)}
              aria-label={date.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
              aria-pressed={isSelected}
              disabled={!inMonth}
            >
              <span className="home-calendar-day-num">{date.getDate()}</span>
              {(hasCalendar || hasRecorded) && (
                <span className="home-calendar-dots" aria-hidden="true">
                  {hasCalendar && <span className="home-calendar-dot home-calendar-dot--cal" />}
                  {hasRecorded && <span className="home-calendar-dot home-calendar-dot--rec" />}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="home-calendar-legend">
        <span className="home-calendar-legend-item">
          <span className="home-calendar-dot home-calendar-dot--cal" aria-hidden="true" />
          Scheduled
        </span>
        <span className="home-calendar-legend-item">
          <span className="home-calendar-dot home-calendar-dot--rec" aria-hidden="true" />
          Recorded
        </span>
        {selectedDay && (
          <button type="button" className="link-btn" onClick={() => onSelectDay(null)}>
            Clear day filter
          </button>
        )}
      </div>
    </section>
  );
}
