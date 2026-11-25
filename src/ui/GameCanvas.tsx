import { useEffect, useRef } from "react";
import { Engine } from "../render/Engine";

/** Hosts the 3D canvas. The engine is created once per mount and never re-rendered by React. */
export function GameCanvas({ onEngine }: { onEngine: (engine: Engine | null) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const engine = new Engine();
    engine.mount(hostRef.current!);
    onEngine(engine);
    return () => {
      engine.destroy();
      onEngine(null);
    };
  }, [onEngine]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
