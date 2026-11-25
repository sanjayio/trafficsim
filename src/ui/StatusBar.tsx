import { useGame } from "../state/store";

export function StatusBar() {
  const fps = useGame((s) => s.stats.fps);

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-end whitespace-nowrap text-xs text-neutral-400">
      <div className="rounded-lg bg-neutral-900/70 px-2.5 py-1 tabular-nums backdrop-blur">{fps} fps</div>
    </div>
  );
}
