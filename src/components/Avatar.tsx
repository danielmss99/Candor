import { people } from "../data/mock";

interface AvatarProps {
  who?: keyof typeof people;
  /** Override label (e.g. "+6"). */
  label?: string;
  bg?: string;
  fg?: string;
  size?: number;
  /** White ring matching the surface, used in overlapping stacks. */
  ring?: string;
}

/** Initials circle with the participant's consistent brand color. */
export function Avatar({ who, label, bg, fg, size = 26, ring }: AvatarProps) {
  const p = who ? people[who] : undefined;
  const background = bg ?? p?.bg ?? "var(--chip-bg)";
  const color = fg ?? p?.fg ?? "var(--text-label)";
  const text = label ?? p?.initials ?? "";

  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background,
        color,
        font: `600 ${Math.round(size * 0.38)}px/${size}px var(--font-sans)`,
        textAlign: "center",
        flex: "none",
        display: "inline-block",
        border: ring ? `2px solid ${ring}` : undefined,
      }}
    >
      {text}
    </span>
  );
}
