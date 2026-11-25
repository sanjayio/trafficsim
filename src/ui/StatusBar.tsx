import { isTauri } from "../platform";
import { useGame } from "../state/store";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function StatusBar() {
  const stats = useGame((s) => s.stats);

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-end whitespace-nowrap text-xs text-neutral-400">
      <div className="flex gap-4 rounded-lg bg-neutral-900/70 px-2.5 py-1 tabular-nums backdrop-blur">
        <span>{plural(stats.segments, "road")}</span>
        <span>{plural(stats.nodes, "node")}</span>
        <span>sim {formatTime(stats.simTime)}</span>
        <span>{stats.fps} fps</span>
        <span>{isTauri ? "desktop" : "web"}</span>
      </div>
    </div>
  );
}
