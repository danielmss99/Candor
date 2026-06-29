import { useId } from "react";

type ScalesLogoSize = "sm" | "md" | "lg";

interface ScalesLogoSvgProps {
  className?: string;
  size?: ScalesLogoSize;
  variant?: "default" | "light";
}

const SIZE_PX: Record<ScalesLogoSize, number> = {
  sm: 24,
  md: 36,
  lg: 48,
};

/** Flat SVG fallback when WebGL is unavailable. */
export function ScalesLogoSvg({ className = "", size = "sm", variant = "default" }: ScalesLogoSvgProps) {
  const uid = useId().replace(/:/g, "");
  const bronze = `candor-bronze-${uid}`;
  const bronzeHi = `candor-bronze-hi-${uid}`;
  const bronzeLo = `candor-bronze-lo-${uid}`;
  const px = SIZE_PX[size];
  const onDark = variant === "light";

  const classes = [
    "scales-logo",
    `scales-logo--${size}`,
    onDark ? "scales-logo--light" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      width={px}
      height={Math.round(px * (56 / 48))}
      viewBox="0 0 48 56"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={bronze} x1="14" y1="2" x2="36" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={onDark ? "#FFF0C8" : "#F0D898"} />
          <stop offset="35%" stopColor={onDark ? "#E8C060" : "#C99438"} />
          <stop offset="100%" stopColor={onDark ? "#7A4E14" : "#5C3810"} />
        </linearGradient>
        <linearGradient id={bronzeHi} x1="20" y1="4" x2="28" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <linearGradient id={bronzeLo} x1="24" y1="30" x2="24" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3D2810" />
          <stop offset="100%" stopColor="#1A1008" />
        </linearGradient>
      </defs>

      <g className="scales-logo-shadow" fill="#1A1008" opacity={onDark ? 0.45 : 0.22}>
        <path d="M11 51.5h26l-2 4.5H13l-2-4.5Z" />
        <ellipse cx="24" cy="52.5" rx="14" ry="2.2" />
      </g>

      <path d="M10 48.5h28l-2.2 5H12.2L10 48.5Z" fill={`url(#${bronzeLo})`} />
      <path d="M13 44.5h22l-1.8 4H14.8l-1.8-4Z" fill={`url(#${bronze})`} />

      <g fill={`url(#${bronze})`}>
        <path d="M19.5 10.5h9l-1.2 34h-6.6l-1.2-34Z" />
        <circle cx="24" cy="7.5" r="4" />
        <rect x="4.5" y="14.5" width="39" height="4" rx="2" />
        <circle cx="4.5" cy="16.5" r="4" />
        <circle cx="43.5" cy="16.5" r="4" />
        <path d="M4.5 20v5.5h2.8V20H4.5Zm5.2 0v5.5h2.8V20h-2.8Z" />
        <path d="M35.5 20v5.5h2.8V20h-2.8Zm5.2 0v5.5H43.5V20h-2.8Z" />
        <path d="M2 25.5c0 9.5 4 14.5 10.5 14.5S23 35 23 25.5H2Z" />
        <path d="M25 25.5c0 9.5 4 14.5 10.5 14.5S46 35 46 25.5H25Z" />
      </g>

      <g fill={`url(#${bronzeHi})`} opacity="0.85">
        <path d="M21.2 12.5h2.2v32h-2.2v-32Z" />
        <circle cx="22.5" cy="6.8" r="1.6" />
      </g>
    </svg>
  );
}
