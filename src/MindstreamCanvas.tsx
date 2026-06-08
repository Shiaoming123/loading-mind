import { useEffect, useRef } from "react";
import type { GraphSceneSnapshot, LoadingPhase, TaskStatus, VisualMode } from "./types";

type Props = {
  phase: LoadingPhase;
  status: TaskStatus;
  graphStats: {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
  };
  particlesEnabled: boolean;
  visualMode: VisualMode;
  scene: GraphSceneSnapshot;
};

type Particle = {
  seed: number;
  radius: number;
  angle: number;
  speed: number;
  drift: number;
};

const particleCount = 300;

const phaseProfile: Record<LoadingPhase, { density: number; orbit: number; hue: number; pull: number }> = {
  initializing: { density: 0.24, orbit: 0.58, hue: 38, pull: 0.2 },
  ontology: { density: 0.38, orbit: 0.5, hue: 44, pull: 0.34 },
  graph_build: { density: 0.58, orbit: 0.42, hue: 183, pull: 0.5 },
  evidence: { density: 0.7, orbit: 0.36, hue: 183, pull: 0.62 },
  reasoning: { density: 0.74, orbit: 0.32, hue: 39, pull: 0.7 },
  drafting: { density: 0.64, orbit: 0.3, hue: 183, pull: 0.74 },
  final_reveal: { density: 0.72, orbit: 0.22, hue: 42, pull: 0.86 },
  completed: { density: 0.32, orbit: 0.24, hue: 42, pull: 1 }
};

function createParticles(): Particle[] {
  return Array.from({ length: particleCount }, (_, index) => {
    const seed = Math.sin(index * 999.13) * 10000;
    return {
      seed: seed - Math.floor(seed),
      radius: 0.16 + ((index * 37) % 100) / 120,
      angle: index * 2.399963,
      speed: 0.00013 + ((index * 17) % 70) / 230000,
      drift: 0.45 + ((index * 23) % 100) / 120
    };
  });
}

export function MindstreamCanvas({
  phase,
  status,
  graphStats,
  particlesEnabled,
  visualMode,
  scene
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>(createParticles());
  const phaseRef = useRef(phase);
  const statusRef = useRef(status);
  const graphStatsRef = useRef(graphStats);
  const particlesEnabledRef = useRef(particlesEnabled);
  const visualModeRef = useRef(visualMode);
  const sceneRef = useRef(scene);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    graphStatsRef.current = graphStats;
  }, [graphStats]);

  useEffect(() => {
    particlesEnabledRef.current = particlesEnabled;
  }, [particlesEnabled]);

  useEffect(() => {
    visualModeRef.current = visualMode;
  }, [visualMode]);

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    let frameId = 0;
    let width = 0;
    let height = 0;
    let deviceScale = 1;

    const resize = () => {
      deviceScale = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * deviceScale);
      canvas.height = Math.floor(height * deviceScale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    };

    const render = (time: number) => {
      const profile = phaseProfile[phaseRef.current];
      const paused = statusRef.current === "paused";
      const t = paused ? Math.floor(time / 900) * 900 : time;
      const graphStatsValue = graphStatsRef.current;
      const showParticles = particlesEnabledRef.current;
      const mode = visualModeRef.current;
      const sceneValue = sceneRef.current;
      const semanticLoad = Math.min(
        1,
        graphStatsValue.nodeCount / 14 +
          graphStatsValue.edgeCount / 24 +
          graphStatsValue.clusterCount / 10
      );
      const sceneClusters = sceneValue.clusters;
      const sceneNodes = sceneValue.nodes;
      const sceneCenter =
        sceneClusters.length > 0
          ? {
              x:
                sceneClusters.reduce((sum, cluster) => sum + cluster.x + sceneValue.viewport.offsetX, 0) /
                sceneClusters.length,
              y:
                sceneClusters.reduce((sum, cluster) => sum + cluster.y + sceneValue.viewport.offsetY, 0) /
                sceneClusters.length
            }
          : { x: width * 0.56, y: height * 0.46 };
      const cx = sceneCenter.x;
      const cy = sceneCenter.y;
      const minDim = Math.min(width, height);

      context.fillStyle = mode === "system" ? "rgba(244, 239, 229, 0.16)" : "rgba(244, 239, 229, 0.105)";
      context.fillRect(0, 0, width, height);

      const glow = context.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.72);
      glow.addColorStop(0, `hsla(${profile.hue}, 85%, 72%, ${0.08 + profile.density * 0.07 + semanticLoad * 0.05})`);
      glow.addColorStop(0.34, `rgba(150, 216, 213, ${0.055 + semanticLoad * 0.06})`);
      glow.addColorStop(0.72, mode === "system" ? "rgba(48, 43, 36, 0.022)" : "rgba(48, 43, 36, 0.028)");
      glow.addColorStop(1, "rgba(244, 239, 229, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      if (mode === "system") {
        context.save();
        context.globalCompositeOperation = "multiply";
        context.strokeStyle = "rgba(47, 43, 37, 0.028)";
        context.lineWidth = 1;
        for (let x = 0; x < width; x += 48) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
        }
        for (let y = 0; y < height; y += 48) {
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(width, y);
          context.stroke();
        }
        context.restore();
      }

      for (const cluster of sceneClusters) {
        const x = cluster.x + sceneValue.viewport.offsetX;
        const y = cluster.y + sceneValue.viewport.offsetY;
        const radius = cluster.radius * (mode === "system" ? 1.04 : 1.26);
        const clusterGlow = context.createRadialGradient(x, y, 0, x, y, radius);
        clusterGlow.addColorStop(0, cluster.active ? "rgba(243, 164, 59, 0.1)" : "rgba(141, 199, 192, 0.075)");
        clusterGlow.addColorStop(0.48, cluster.active ? "rgba(141, 199, 192, 0.065)" : "rgba(255, 252, 244, 0.04)");
        clusterGlow.addColorStop(1, "rgba(255, 252, 244, 0)");
        context.fillStyle = clusterGlow;
        context.beginPath();
        context.ellipse(x, y, radius, radius * 0.62, -0.16, 0, Math.PI * 2);
        context.fill();
      }

      for (const node of sceneNodes) {
        const x = node.x + sceneValue.viewport.offsetX;
        const y = node.y + sceneValue.viewport.offsetY;
        const radius = node.radius * (node.active ? 4.4 : node.reportMapped ? 3.2 : 2.6);
        const nodeGlow = context.createRadialGradient(x, y, 0, x, y, radius);
        nodeGlow.addColorStop(0, node.active ? "rgba(243, 164, 59, 0.14)" : "rgba(141, 199, 192, 0.06)");
        nodeGlow.addColorStop(1, "rgba(255, 252, 244, 0)");
        context.fillStyle = nodeGlow;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }

      if (showParticles) {
        context.save();
        context.globalCompositeOperation = "screen";
        for (const particle of particlesRef.current) {
          const local = t * particle.speed + particle.angle;
          const wave = Math.sin(local * 2.1 + particle.seed * 8);
          const contraction = 1 - profile.pull * 0.38 - semanticLoad * 0.08;
          const orbit = minDim * (profile.orbit * particle.radius * contraction);
          const x =
            cx +
            Math.cos(local) * orbit * (1.36 + wave * 0.06) +
            Math.sin(local * 0.37) * minDim * 0.06 * particle.drift;
          const y =
            cy +
            Math.sin(local * 1.24) * orbit * 0.44 +
            Math.cos(local * 0.53) * minDim * 0.028 * particle.drift;
          const size = 0.7 + profile.density * 1.4 + semanticLoad * 0.8 + particle.seed;
          const alpha = 0.035 + profile.density * 0.12 + semanticLoad * 0.08 + particle.seed * 0.05;

          context.beginPath();
          context.fillStyle = `hsla(${profile.hue + particle.seed * 20}, 82%, 68%, ${alpha})`;
          context.arc(x, y, size, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }

      frameId = window.requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    frameId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  return <canvas className="mindstream-canvas" ref={canvasRef} aria-hidden="true" />;
}
