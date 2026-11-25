import { Check, Cloud, CloudRain, Moon, Sun, Sunset, Wind, type LucideIcon } from "lucide-react";
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

export function StatusBar() {
  const fps = useGame((s) => s.stats.fps);
  const autosave = useGame((s) => s.autosave);
  const timeOfDay = useGame((s) => s.timeOfDay);
  const weather = useGame((s) => s.weather);
  const DayIcon = partOfDay(timeOfDay);

  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-end whitespace-nowrap text-xs text-neutral-400">
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
        <span>{fps} fps</span>
      </div>
    </div>
  );
}
