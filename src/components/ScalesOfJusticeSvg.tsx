/** Static SVG fallback when WebGL is unavailable. */
export function ScalesOfJusticeSvg() {
  return (
    <svg
      className="scales-svg"
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id="scales-gold" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffd98a" />
          <stop offset="45%" stopColor="#ffb24d" />
          <stop offset="100%" stopColor="#e8942a" />
        </linearGradient>
        <linearGradient id="scales-shine" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <filter id="scales-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <circle cx="100" cy="100" r="92" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
      <circle cx="100" cy="100" r="84" stroke="url(#scales-gold)" strokeWidth="2" opacity="0.55" />

      <rect x="96" y="58" width="8" height="72" rx="2" fill="url(#scales-gold)" filter="url(#scales-glow)" />
      <rect x="96" y="58" width="4" height="72" rx="1" fill="url(#scales-shine)" opacity="0.5" />

      <path
        d="M72 132 L128 132 L118 148 L82 148 Z"
        fill="url(#scales-gold)"
        filter="url(#scales-glow)"
      />
      <ellipse cx="100" cy="148" rx="28" ry="5" fill="#c47a18" opacity="0.45" />

      <rect x="48" y="62" width="104" height="6" rx="3" fill="url(#scales-gold)" filter="url(#scales-glow)" />
      <rect x="48" y="62" width="104" height="2" rx="1" fill="url(#scales-shine)" opacity="0.4" />

      <path
        d="M58 68 C58 82 58 88 58 96"
        stroke="url(#scales-gold)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M68 68 C68 82 68 88 68 96"
        stroke="url(#scales-gold)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M132 68 C132 82 132 88 132 96"
        stroke="url(#scales-gold)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M142 68 C142 82 142 88 142 96"
        stroke="url(#scales-gold)"
        strokeWidth="2"
        strokeLinecap="round"
      />

      <path
        d="M38 96 C38 108 48 114 63 114 C78 114 88 108 88 96"
        stroke="url(#scales-gold)"
        strokeWidth="2.5"
        fill="rgba(255,178,77,0.15)"
      />
      <ellipse cx="63" cy="114" rx="25" ry="4" fill="#ffb24d" opacity="0.35" />

      <path
        d="M112 96 C112 108 122 114 137 114 C152 114 162 108 162 96"
        stroke="url(#scales-gold)"
        strokeWidth="2.5"
        fill="rgba(255,178,77,0.15)"
      />
      <ellipse cx="137" cy="114" rx="25" ry="4" fill="#ffb24d" opacity="0.35" />

      <circle cx="100" cy="52" r="8" fill="url(#scales-gold)" filter="url(#scales-glow)" />
      <circle cx="100" cy="50" r="3" fill="url(#scales-shine)" opacity="0.6" />
    </svg>
  );
}
