import { useEffect, useState } from "react";
import { ScalesOfJustice3D } from "./ScalesOfJustice3D";
import { ScalesOfJusticeSvg } from "./ScalesOfJusticeSvg";

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

/** Golden scales of justice — 3D WebGL hero with SVG fallback. */
export function ScalesOfJustice() {
  const [use3d, setUse3d] = useState<boolean | null>(null);

  useEffect(() => {
    setUse3d(detectWebGL());
  }, []);

  if (use3d === null) {
    return <div className="scales-placeholder" aria-hidden />;
  }

  if (!use3d) {
    return <ScalesOfJusticeSvg />;
  }

  return <ScalesOfJustice3D onWebGLFailed={() => setUse3d(false)} />;
}
