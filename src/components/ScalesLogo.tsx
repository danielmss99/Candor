import { useEffect, useState } from "react";
import { ScalesLogo3D } from "./ScalesLogo3D";
import { ScalesLogoSvg } from "./ScalesLogoSvg";

type ScalesLogoSize = "sm" | "md" | "lg";

interface ScalesLogoProps {
  className?: string;
  size?: ScalesLogoSize;
  /** Brighter lighting for the landing gradient header. */
  variant?: "default" | "light";
}

function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false }) ??
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: false });
    return context !== null;
  } catch {
    return false;
  }
}

const PLACEHOLDER_H: Record<ScalesLogoSize, number> = {
  sm: 28,
  md: 42,
  lg: 56,
};

/** Candor brand mark — miniature 3D bronze scales with SVG fallback. */
export function ScalesLogo({ className = "", size = "sm", variant = "default" }: ScalesLogoProps) {
  const [use3d, setUse3d] = useState<boolean | null>(null);

  useEffect(() => {
    setUse3d(detectWebGL());
  }, []);

  if (use3d === null) {
    return (
      <span
        className={`scales-logo scales-logo--placeholder scales-logo--${size} ${className}`.trim()}
        style={{ height: PLACEHOLDER_H[size] }}
        aria-hidden
      />
    );
  }

  if (!use3d) {
    return <ScalesLogoSvg className={className} size={size} variant={variant} />;
  }

  return (
    <ScalesLogo3D
      className={className}
      size={size}
      variant={variant}
      onWebGLFailed={() => setUse3d(false)}
    />
  );
}
