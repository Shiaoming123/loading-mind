import { useEffect, useRef } from "react";
import type { GraphSceneSnapshot, LoadingPhase, TaskStatus } from "./types";

type Props = {
  phase: LoadingPhase;
  status: TaskStatus;
  graphStats: {
    nodeCount: number;
    edgeCount: number;
    clusterCount: number;
  };
  scene: GraphSceneSnapshot;
};

export function MindstreamCanvas({
  phase,
  status,
  graphStats,
  scene
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(phase);
  const statusRef = useRef(status);
  const graphStatsRef = useRef(graphStats);
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
      const visualViewport = window.visualViewport;
      deviceScale = Math.min(window.devicePixelRatio || 1, 2);
      width = visualViewport?.width ?? window.innerWidth;
      height = visualViewport?.height ?? window.innerHeight;
      canvas.width = Math.floor(width * deviceScale);
      canvas.height = Math.floor(height * deviceScale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    };

    const render = (time: number) => {
      const paused = statusRef.current === "paused";
      const alpha = paused ? 0.16 : 0.13;

      context.fillStyle = `rgba(244, 239, 229, ${alpha})`;
      context.fillRect(0, 0, width, height);

      frameId = window.requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    frameId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  return <canvas className="mindstream-canvas" ref={canvasRef} aria-hidden="true" />;
}
