import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { buildScalesEmblem, createSunriseEnvironment } from "./scales/buildEmblem";

const BASE_Y = 0.14;

function SunriseEnvironment() {
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

function ScalesLights() {
  return (
    <>
      <hemisphereLight args={[0xffe8c4, 0x3a2060, 0.45]} />
      <directionalLight color={0xffe6b8} intensity={1.3} position={[3, 5, 4]} />
      <directionalLight color={0xd081d8} intensity={0.55} position={[-5, 0, 2]} />
      <directionalLight color={0xff7a4d} intensity={0.85} position={[-2, -2, -5]} />
    </>
  );
}

function FloatingScales() {
  const groupRef = useRef<THREE.Group>(null);
  const emblemRef = useRef<THREE.Group | null>(null);

  useLayoutEffect(() => {
    const emblem = buildScalesEmblem();
    emblemRef.current = emblem;
    groupRef.current?.add(emblem);

    return () => {
      if (emblemRef.current && groupRef.current) {
        groupRef.current.remove(emblemRef.current);
      }
      emblemRef.current?.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((material) => material.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      emblemRef.current = null;
    };
  }, []);

  useFrame(({ clock }) => {
    const group = groupRef.current;
    if (!group) return;

    const t = clock.getElapsedTime();
    group.rotation.y = Math.sin(t * 0.45) * 0.55;
    group.rotation.x = -0.06 + Math.sin(t * 0.7) * 0.04;
    group.position.y = BASE_Y + Math.sin(t * 0.9) * 0.035;
  });

  return <group ref={groupRef} />;
}

interface ScalesCanvasProps {
  onWebGLFailed?: () => void;
}

function ScalesCanvas({ onWebGLFailed }: ScalesCanvasProps) {
  return (
    <Canvas
      className="scales-canvas"
      dpr={[1, 2.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 6.4], fov: 38, near: 0.1, far: 100 }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.18;

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
        <SunriseEnvironment />
        <ScalesLights />
        <FloatingScales />
      </Suspense>
    </Canvas>
  );
}

interface ScalesOfJustice3DProps {
  onWebGLFailed?: () => void;
}

export function ScalesOfJustice3D({ onWebGLFailed }: ScalesOfJustice3DProps) {
  return (
    <div className="scales-3d-wrap">
      <span className="scales-frame-ring scales-frame-ring--outer" aria-hidden />
      <span className="scales-frame-ring scales-frame-ring--inner" aria-hidden />
      <ScalesCanvas onWebGLFailed={onWebGLFailed} />
    </div>
  );
}
