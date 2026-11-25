/** The game's name, top left. */
export function Logo() {
  return (
    <div className="pointer-events-none absolute left-3 top-3 select-none rounded-xl border border-white/10 bg-neutral-900/90 px-3 py-1.5 text-lg font-bold tracking-tight shadow-lg shadow-black/30 backdrop-blur">
      <span className="text-white">Traffic</span>
      <span className="text-sky-400">Sim</span>
    </div>
  );
}
