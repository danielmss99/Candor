import { useCallback, useEffect, useState } from "react";
import type { View } from "../App";
import { Avatar } from "../components/Avatar";
import { Sidebar } from "../components/Sidebar";
import {
  VOICE_COLORS,
  loadPeople,
  newPerson,
  persistPeople,
  type VoicePerson,
} from "../api/local";

interface PeopleProps {
  onNavigate: (view: View) => void;
}

export function People({ onNavigate }: PeopleProps) {
  const [people, setPeople] = useState<VoicePerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [voiceLabel, setVoiceLabel] = useState("");
  const [color, setColor] = useState(VOICE_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setPeople(await loadPeople());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (next: VoicePerson[]) => {
    setSaving(true);
    setPeople(next);
    await persistPeople(next);
    setSaving(false);
  };

  const addPerson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const person = newPerson(name, voiceLabel || "Default voice", color);
    await save([...people, person]);
    setName("");
    setVoiceLabel("");
    setColor(VOICE_COLORS[(people.length + 1) % VOICE_COLORS.length]);
  };

  const removePerson = async (id: string) => {
    await save(people.filter((p) => p.id !== id));
  };

  return (
    <div className="screen screen--sidebar">
      <Sidebar active="People" onNavigate={onNavigate} />

      <div className="main main--scroll">
        <div className="library-head">
          <span className="page-title">People</span>
          <span className="page-sub">Voice profiles for speaker recognition</span>
          <div className="spacer" />
          {saving && <span className="page-sub">Saving…</span>}
        </div>

        <p className="people-intro">
          Add people you meet with often. Candor stores their profile locally so future recordings
          can match voices to names (speaker ID coming soon).
        </p>

        <form className="people-form" onSubmit={addPerson}>
          <div className="people-form-row">
            <input
              className="people-input"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Name"
            />
            <input
              className="people-input people-input--wide"
              placeholder="Voice notes (e.g. deep, fast talker, British accent)"
              value={voiceLabel}
              onChange={(e) => setVoiceLabel(e.target.value)}
              aria-label="Voice description"
            />
          </div>
          <div className="people-form-row">
            <div className="color-picker">
              {VOICE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${color === c ? "color-swatch--active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
            <button type="submit" className="btn-primary" disabled={!name.trim()}>
              Add person
            </button>
          </div>
        </form>

        <div className="section-label section-label--block">SAVED LOCALLY · {people.length}</div>

        {loading ? (
          <div className="library-empty">Loading people…</div>
        ) : people.length === 0 ? (
          <div className="library-empty">No people yet — add someone above.</div>
        ) : (
          <div className="people-list">
            {people.map((p) => (
              <div key={p.id} className="people-row">
                <Avatar label={p.initials} bg={p.color} fg="#fff" size={36} />
                <div className="people-row-main">
                  <div className="people-row-name">{p.name}</div>
                  <div className="people-row-voice">{p.voiceLabel || "No voice notes"}</div>
                </div>
                <button type="button" className="btn-ghost btn-ghost-sm" onClick={() => removePerson(p.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
