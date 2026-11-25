import { useGame } from "../state/store";

/** The game's name, top left, and the map's. */
export function Logo() {
  const mapName = useGame((s) => s.mapName);
  return (
    <div className="pointer-events-none absolute left-3 top-3 flex select-none items-center gap-3 rounded-xl border border-white/10 bg-neutral-900/90 px-3 py-1.5 shadow-lg shadow-black/30 backdrop-blur">
      <span className="text-lg font-bold tracking-tight">
        <span className="text-white">Traffic</span>
        <span className="text-sky-400">Sim</span>
      </span>
      {mapName && <span className="max-w-48 truncate border-l border-white/10 pl-3 text-neutral-400">{mapName}</span>}
    </div>
  );
}
