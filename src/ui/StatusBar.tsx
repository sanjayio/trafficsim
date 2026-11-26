import { Activity, Check, Cloud, CloudRain, Moon, RotateCcw, Sun, Sunset, Wind, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Engine } from "../render/Engine";
import { gameStore, useGame, type Weather } from "../state/store";
import { keepFocusOnGame } from "./Panel";

const AUTOSAVE_TEXT = { saving: "Saving…", saved: "Saved", failed: "Not saved" };

const WEATHERS: { id: Weather; label: string; icon: LucideIcon }[] = [
  { id: "sunny", label: "Sunny", icon: Sun },
  { id: "cloudy", label: "Cloudy", icon: Cloud },
  { id: "rain", label: "Rain", icon: CloudRain },
  { id: "windy", label: "Windy", icon: Wind },
];

/** "13:30" for 13.5 hours. */
function clock(hours: number): string {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Day, golden hour around sunrise and sunset, or night: the slider's icon. */
function partOfDay(hours: number): LucideIcon {
  if (hours < 5.5 || hours >= 19.5) return Moon;
  if (hours < 8 || hours >= 17) return Sunset;
  return Sun;
}

/** Live traffic measures, to see how the traffic rules play out; opened from the status bar. */
function TrafficStatsPanel({ engine }: { engine: Engine | null }) {
  const traffic = useGame((s) => s.stats.traffic);
  const rows: [string, string][] = traffic
    ? [
        ["Cars driving", `${traffic.cars}`],
        ["Stuck (still 10 s+)", `${traffic.stuck}`],
        ["Trips finished", `${traffic.trips}`],
        ["Mean trip time", traffic.trips ? `${traffic.meanTrip.toFixed(1)} s` : "–"],
        ["Trips in last minute", `${traffic.perMinute}`],
        ["Lane changes per trip", traffic.trips ? (traffic.laneChanges / traffic.trips).toFixed(2) : "–"],
        ["Reroutes", `${traffic.reroutes}`],
        ["Gave up (stuck too long)", `${traffic.gaveUp}`],
      ]
    : [];
  return (
    <div className="pointer-events-auto absolute bottom-[5.5rem] right-0 w-64 rounded-xl border border-white/10 bg-neutral-900/90 p-3 text-xs text-neutral-300 shadow-xl shadow-black/40 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium uppercase tracking-wide text-neutral-500">Traffic</span>
        <button
          type="button"
          onClick={() => engine?.sim.resetStats()}
          onMouseDown={keepFocusOnGame}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-neutral-400 transition-colors duration-100 hover:bg-white/10 hover:text-white"
        >
          <RotateCcw size={12} aria-hidden />
          Reset
        </button>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-neutral-400">{label}</dt>
            <dd className="text-right text-neutral-100">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function StatusBar({ engine }: { engine: Engine | null }) {
  const [showStats, setShowStats] = useState(false);
  // Escape closes the stats panel and nothing else (taken before the game sees it), as for the menu.
  useEffect(() => {
    if (!showStats) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setShowStats(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showStats]);
  const fps = useGame((s) => s.stats.fps);
  const autosave = useGame((s) => s.autosave);
  const timeOfDay = useGame((s) => s.timeOfDay);
  const weather = useGame((s) => s.weather);
  const DayIcon = partOfDay(timeOfDay);

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-end whitespace-nowrap text-xs text-neutral-400">
      {showStats && <TrafficStatsPanel engine={engine} />}
      <div className="flex items-center gap-3 rounded-lg bg-neutral-900/70 px-2.5 py-1 tabular-nums backdrop-blur">
        {/* Whether the map is kept in the browser (see Engine.restoreAutosave). */}
        {autosave && (
          <span
            className={`flex items-center gap-1 ${autosave === "failed" ? "text-red-400" : ""}`}
            title={autosave === "failed" ? "Couldn't keep the map in this browser: use Save map" : "The map is kept in this browser"}
          >
            {autosave === "saved" && <Check size={12} aria-hidden />}
            {AUTOSAVE_TEXT[autosave]}
          </span>
        )}
        <div role="radiogroup" aria-label="Weather" className="pointer-events-auto flex items-center gap-0.5">
          {WEATHERS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={weather === id}
              aria-label={label}
              title={label}
              onClick={() => gameStore.getState().setWeather(id)}
              onMouseDown={keepFocusOnGame}
              className={`grid size-6 place-items-center rounded-md transition-colors duration-100 ${
                weather === id ? "bg-sky-500/90 text-white" : "text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
              }`}
            >
              <Icon size={13} aria-hidden />
            </button>
          ))}
        </div>
        <label className="pointer-events-auto flex items-center gap-1.5" title="Time of day">
          <DayIcon size={13} aria-hidden />
          <input
            type="range"
            aria-label="Time of day"
            min={0}
            max={24}
            step={0.25}
            value={timeOfDay}
            onChange={(e) => gameStore.getState().setTimeOfDay(Number(e.target.value))}
            // Hand keyboard focus back to the game.
            onPointerUp={(e) => e.currentTarget.blur()}
            className="w-24 accent-sky-500"
          />
          <span className="w-9 text-neutral-300">{clock(timeOfDay)}</span>
        </label>
        <button
          type="button"
          aria-expanded={showStats}
          title="Traffic stats"
          onClick={() => setShowStats(!showStats)}
          onMouseDown={keepFocusOnGame}
          className={`pointer-events-auto -mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors duration-100 hover:bg-white/10 hover:text-neutral-100 ${
            showStats ? "text-neutral-100" : ""
          }`}
        >
          <Activity size={12} aria-hidden />
          {fps} fps
        </button>
      </div>
    </div>
  );
}
