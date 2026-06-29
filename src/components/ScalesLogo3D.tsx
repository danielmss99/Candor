import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { buildScalesEmblem, createSunriseEnvironment, GOLD_MATERIAL } from "./scales/buildEmblem";

type ScalesLogoSize = "sm" | "md" | "lg";

const SIZE_PX: Record<ScalesLogoSize, { w: number; h: number }> = {
  sm: { w: 24, h: 28 },
  md: { w: 36, h: 42 },
  lg: { w: 48, h: 56 },
};

function LogoEnvironment() {
  const { gl, scene } = useThree();

  useLayoutEffect(() => {
    const envMap = createSunriseEnvironment(gl);
    if (!envMap) return;

    const previous = scene.environment;
    scene.environment = envMap;

    return () => {
      envMap.dispose();
      scene.environment = previous ?? null;
    };
  }, [gl, scene]);

  return null;
}

function LogoLights({ bright }: { bright: boolean }) {
  return (
    <>
      <hemisphereLight
        args={[bright ? 0xfff4dc : 0xffe8c4, bright ? 0x281848 : 0x3a2060, bright ? 0.55 : 0.42]}
      />
      <directionalLight color={0xffe6b8} intensity={bright ? 1.55 : 1.15} position={[2.5, 4, 3.5]} />
      <directionalLight color={0xd081d8} intensity={bright ? 0.45 : 0.3} position={[-4, 1, 2]} />
      <directionalLight color={0xff7a4d} intensity={bright ? 0.75 : 0.55} position={[-1.5, -2, -4]} />
    </>
  );
}

function LogoEmblem() {
  const groupRef = useRef<THREE.Group>(null);
  const emblemRef = useRef<THREE.Group | null>(null);

  useLayoutEffect(() => {
    const mat = GOLD_MATERIAL.clone();
    const emblem = buildScalesEmblem(mat);
    emblemRef.current = emblem;
    groupRef.current?.add(emblem);

    return () => {
      if (emblemRef.current && groupRef.current) {
        groupRef.current.remove(emblemRef.current);
      }
      emblemRef.current?.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => {
            if (material !== mat) material.dispose();
          });
        }
      });
      mat.dispose();
      emblemRef.current = null;
    };
  }, []);

  useFrame(({ clock }) => {
    const group = groupRef.current;
    if (!group) return;
    const t = clock.getElapsedTime();
    group.rotation.y = Math.sin(t * 0.35) * 0.22;
    group.rotation.x = -0.04;
  });

  return <group ref={groupRef} />;
}

interface LogoCanvasProps {
  bright: boolean;
  dpr: number;
  onWebGLFailed?: () => void;
}

function LogoCanvas({ bright, dpr, onWebGLFailed }: LogoCanvasProps) {
  return (
    <Canvas
      className="scales-logo-canvas"
      dpr={dpr}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0.05, 6.2], fov: 36, near: 0.1, far: 100 }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = bright ? 1.28 : 1.12;

        const canvas = gl.domElement;
        const handleContextLost = (event: Event) => {
          event.preventDefault();
          onWebGLFailed?.();
        };
        canvas.addEventListener("webglcontextlost", handleContextLost);
        return () => canvas.removeEventListener("webglcontextlost", handleContextLost);
      }}
    >
      <Suspense fallback={null}>
        <LogoEnvironment />
        <LogoLights bright={bright} />
        <LogoEmblem />
      </Suspense>
    </Canvas>
  );
}

export interface ScalesLogo3DProps {
  className?: string;
  size?: ScalesLogoSize;
  variant?: "default" | "light";
  onWebGLFailed?: () => void;
}

export function ScalesLogo3D({
  className = "",
  size = "sm",
  variant = "default",
  onWebGLFailed,
}: ScalesLogo3DProps) {
  const { w, h } = SIZE_PX[size];
  const bright = variant === "light";
  const dpr = size === "sm" ? 1.5 : 2;

  const classes = [
    "scales-logo",
    "scales-logo-3d-wrap",
    `scales-logo--${size}`,
    bright ? "scales-logo--light" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} style={{ width: w, height: h }} aria-hidden>
      <LogoCanvas bright={bright} dpr={dpr} onWebGLFailed={onWebGLFailed} />
    </div>
  );
}
