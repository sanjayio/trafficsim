import { Ban, Octagon, RefreshCw, Settings2, Triangle, X, type LucideProps } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { MAX_CORNER_RADIUS, type JunctionControl, type JunctionSettings } from "../core/junction";
import type { Engine } from "../render/Engine";
import { gameStore, useGame } from "../state/store";
import { keepFocusOnGame } from "./Panel";

const PANEL_WIDTH = 264;
const PANEL_HEIGHT = 250;
const EDGE = 12;

/** A traffic light, drawn in the lucide style (the set has none). */
function TrafficLightIcon({ size = 24, strokeWidth = 2, ...props }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="7" y="2" width="10" height="20" rx="3" />
      <circle cx="12" cy="7" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="17" r="1.6" />
    </svg>
  );
}

const CONTROLS: { id: JunctionControl; label: string; icon: ReactNode }[] = [
  { id: "none", label: "None", icon: <Ban size={16} aria-hidden /> },
  { id: "yield", label: "Give way", icon: <Triangle size={16} className="rotate-180" aria-hidden /> },
  { id: "stop", label: "Stop", icon: <Octagon size={16} aria-hidden /> },
  { id: "signals", label: "Signals", icon: <TrafficLightIcon size={16} aria-hidden /> },
];

/**
 * Junction options: a ⚙ button beside the hovered junction, and the options panel for the open
 * one. Both follow their junction as the camera moves.
 */
export function JunctionOverlay({ engine }: { engine: Engine | null }) {
  const hover = useGame((s) => s.junctionHover);
  const open = useGame((s) => s.junctionOpen);
  if (!engine) return null;
  if (open) return <JunctionPanel engine={engine} id={open.id} x={open.x} y={open.y} />;
  if (!hover) return null;
  return (
    <button
      type="button"
      aria-label="Junction options"
      title="Junction options"
      onMouseDown={keepFocusOnGame}
      onClick={() => {
        gameStore.getState().setJunctionOpen(hover);
        gameStore.getState().setJunctionHover(null);
      }}
      className="absolute grid size-8 place-items-center rounded-full border border-white/15 bg-neutral-900/90 text-neutral-200 shadow-lg shadow-black/40 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
      // Up and to the right of the junction, so clicks on the junction itself still reach the map.
      style={{ left: hover.x + 14, top: hover.y - 46 }}
    >
      <Settings2 size={16} aria-hidden />
    </button>
  );
}

function useJunctionSettings(engine: Engine, id: number): JunctionSettings {
  const [settings, setSettings] = useState(() => engine.graph.junction(id));
  useEffect(() => {
    setSettings(engine.graph.junction(id));
    return engine.graph.subscribe((e) => {
      if (e.type === "junction-changed" && e.nodeId === id) setSettings(engine.graph.junction(id));
    });
  }, [engine, id]);
  return settings;
}

function JunctionPanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const settings = useJunctionSettings(engine, id);
  const update = (changes: Partial<JunctionSettings>) => engine.graph.setJunction(id, changes);
  const close = () => gameStore.getState().setJunctionOpen(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") gameStore.getState().setJunctionOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Beside the junction, kept inside the window.
  const left = Math.min(Math.max(EDGE, x + 28), window.innerWidth - PANEL_WIDTH - EDGE);
  const top = Math.min(Math.max(EDGE, y - PANEL_HEIGHT / 2), window.innerHeight - PANEL_HEIGHT - EDGE);

  return (
    <div
      role="dialog"
      aria-label="Junction options"
      className="absolute flex flex-col gap-3 rounded-xl border border-white/10 bg-neutral-900/95 p-3 shadow-xl shadow-black/40 backdrop-blur"
      style={{ left, top, width: PANEL_WIDTH }}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Junction</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          onMouseDown={keepFocusOnGame}
          className="grid size-7 place-items-center rounded-lg text-neutral-400 transition-colors duration-100 hover:bg-white/10 hover:text-white"
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      <fieldset disabled={settings.roundabout} className="flex flex-col gap-1.5 disabled:opacity-40">
        <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-500">
          Control{settings.roundabout ? " (roundabouts give way)" : ""}
        </legend>
        <div role="radiogroup" aria-label="Control" className="grid grid-cols-4 gap-1">
          {CONTROLS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={settings.control === c.id}
              onClick={() => update({ control: c.id })}
              onMouseDown={keepFocusOnGame}
              className={`flex flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition-colors duration-100 ${
                settings.control === c.id ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        role="switch"
        aria-checked={settings.roundabout}
        onClick={() => update({ roundabout: !settings.roundabout })}
        onMouseDown={keepFocusOnGame}
        className="flex items-center justify-between rounded-lg px-1 py-1 text-neutral-200 transition-colors duration-100 hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <RefreshCw size={15} className="text-neutral-400" aria-hidden />
          Roundabout
        </span>
        <span
          className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${settings.roundabout ? "bg-sky-500" : "bg-white/20"}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow transition-transform duration-150 ${
              settings.roundabout ? "translate-x-3" : ""
            }`}
          />
        </span>
      </button>

      <label className="flex flex-col gap-1.5 px-1">
        <span className="flex justify-between text-neutral-200">
          Corner smoothness
          <span className="tabular-nums text-neutral-400">{settings.cornerRadius}</span>
        </span>
        {settings.roundabout && (
          <span className="-mt-1 text-xs text-neutral-500">Flares the entries and sizes the splitter islands</span>
        )}
        <input
          type="range"
          min={0}
          max={MAX_CORNER_RADIUS}
          step={2}
          value={settings.cornerRadius}
          onChange={(e) => update({ cornerRadius: Number(e.target.value) })}
          // Hand keyboard focus back to the game once the slider is let go.
          onPointerUp={(e) => e.currentTarget.blur()}
          className="w-full accent-sky-500"
        />
      </label>
    </div>
  );
}
