import type { View } from "../App";
import { ScalesOfJustice } from "../components/ScalesOfJustice";

interface LandingProps {
  onNavigate: (view: View) => void;
  onStartRecording: () => void;
}

const JUMP_CARDS = [
  {
    title: "Home",
    desc: "Today's agenda, recent meetings & what's next",
    target: "home" as View,
    variant: "solid" as const,
    iconBg: "#f0714e",
    arrowColor: "#f0714e",
    icon: "home" as const,
  },
  {
    title: "Meetings",
    desc: "Every transcript, summary & recording in one place",
    target: "library" as View,
    variant: "glass" as const,
    iconBg: "rgba(255,255,255,0.28)",
    arrowColor: "#fff",
    icon: "meetings" as const,
  },
  {
    title: "Tasks",
    desc: "Action items from every meeting — open to done",
    target: "actions" as View,
    variant: "solid" as const,
    iconBg: "#ffb24d",
    arrowColor: "#e8932f",
    icon: "tasks" as const,
  },
] as const;

function JumpCardIcon({ type }: { type: "home" | "meetings" | "tasks" }) {
  if (type === "home") {
    return <span className="landing-card-icon-shape landing-card-icon-shape--home" aria-hidden />;
  }
  if (type === "meetings") {
    return (
      <span className="landing-card-icon-shape landing-card-icon-shape--meetings" aria-hidden>
        <span />
        <span />
        <span />
      </span>
    );
  }
  return (
    <span className="landing-card-icon-shape landing-card-icon-shape--tasks" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

export function Landing({ onNavigate, onStartRecording }: LandingProps) {
  return (
    <div className="landing">
      <aside className="landing-visual" aria-hidden>
        <div className="landing-visual-distortion" />
        <div className="landing-visual-glow" />
        <div className="landing-scales-frame">
          <ScalesOfJustice />
        </div>
        <span className="landing-visual-badge">CANDOR · NOTHING LEFT UNSAID</span>
      </aside>

      <div className="landing-content">
        <header className="landing-header">
          <div className="landing-brand" aria-label="Candor">
            <span className="landing-wordmark">CANDOR</span>
          </div>
          <p className="landing-tagline">AI MEETING TRANSCRIPTION</p>
        </header>

        <main className="landing-main">
          <div className="landing-hero-copy">
            <h1 className="landing-headline">
              Every word,
              <br />
              on the <span className="landing-highlight">record.</span>
            </h1>
            <p className="landing-sub">
              Honest, searchable transcripts of every meeting — captured, summarized, and
              organized the moment you stop talking.
            </p>
            <button type="button" className="landing-cta" onClick={onStartRecording}>
              <span className="landing-cta-dot" />
              Start recording
            </button>
          </div>

          <section className="landing-jump" aria-labelledby="landing-jump-label">
            <h2 id="landing-jump-label" className="landing-jump-label">
              JUMP IN
            </h2>
            <div className="landing-cards">
              {JUMP_CARDS.map((card) => (
                <button
                  key={card.title}
                  type="button"
                  className={`landing-card${card.variant === "glass" ? " landing-card--glass" : ""}`}
                  onClick={() => onNavigate(card.target)}
                >
                  <span
                    className="landing-card-icon-wrap"
                    style={{ background: card.iconBg }}
                  >
                    <JumpCardIcon type={card.icon} />
                  </span>
                  <span className="landing-card-body">
                    <span className="landing-card-title">{card.title}</span>
                    <span className="landing-card-desc">{card.desc}</span>
                  </span>
                  <span
                    className="landing-card-arrow"
                    style={{ color: card.arrowColor }}
                    aria-hidden
                  >
                    →
                  </span>
                </button>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
