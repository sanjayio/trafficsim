import { Ban, CornerUpRight, GitMerge, Octagon, RefreshCw, Settings2, Triangle, type LucideProps } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { mainRoadChoices, MAX_CORNER_RADIUS, slipRoad, type JunctionControl, type JunctionSettings, type SlipControl } from "../core/junction";
import type { Engine } from "../render/Engine";
import { gameStore, useGame } from "../state/store";
import { OptionsPanel, Switch } from "./OptionsPanel";
import { keepFocusOnGame } from "./Panel";
import { BuildingPanel } from "./BuildingPanel";

const PANEL_HEIGHT = 290;

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
 * Junction and building options: a ⚙ button beside the hovered junction or building, and the options
 * panel for the open one. Both follow their node as the camera moves.
 */
export function JunctionOverlay({ engine }: { engine: Engine | null }) {
  const hover = useGame((s) => s.junctionHover);
  const open = useGame((s) => s.junctionOpen);
  if (!engine) return null;
  if (open?.kind === "building") return <BuildingPanel engine={engine} id={open.id} x={open.x} y={open.y} />;
  if (open) return <JunctionPanel engine={engine} id={open.id} x={open.x} y={open.y} />;
  if (!hover) return null;
  return (
    <button
      type="button"
      aria-label={hover.kind === "building" ? "Building options" : "Junction options"}
      title={hover.kind === "building" ? "Building options" : "Junction options"}
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

/** Where a slip road joins: give way (the default), stop, or signals on every approach. */
function SlipPanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const settings = useJunctionSettings(engine, id);
  const current = settings.slipControl ?? "yield";
  const options = CONTROLS.filter((c) => c.id !== "none");
  return (
    <OptionsPanel title="Slip road" x={x} y={y} height={150}>
      <div role="radiogroup" aria-label="Control" className="grid grid-cols-3 gap-1">
        {options.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={current === c.id}
            onClick={() => engine.graph.setJunction(id, { slipControl: c.id === "yield" ? undefined : (c.id as SlipControl) })}
            onMouseDown={keepFocusOnGame}
            className={`flex flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] font-medium transition-colors duration-100 ${
              current === c.id ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {c.icon}
            {c.label}
          </button>
        ))}
      </div>
      <p className="px-1 text-xs text-neutral-500">How traffic joining from the slip road meets the main road.</p>
    </OptionsPanel>
  );
}

function JunctionPanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const settings = useJunctionSettings(engine, id);
  if (slipRoad(engine.graph, id)) return <SlipPanel engine={engine} id={id} x={x} y={y} />;
  const update = (changes: Partial<JunctionSettings>) => engine.graph.setJunction(id, changes);
  // Which roads stop or give way can be swapped when there's more than one way to pick the main road.
  const choices = engine.graph.segmentsAt(id).length >= 3 ? mainRoadChoices(engine.graph, id).length : 0;
  const swappable = (settings.control === "stop" || settings.control === "yield") && choices > 1;
  return (
    <OptionsPanel title="Junction" x={x} y={y} height={PANEL_HEIGHT + 20 + (settings.control === "signals" ? 32 : 0)}>
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
              // Stop or give way clicked again: the other roads become the main road.
              onClick={() =>
                update(settings.control === c.id && swappable ? { major: ((settings.major ?? 0) + 1) % choices } : { control: c.id })
              }
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
        {swappable && !settings.roundabout && (
          <p className="px-1 text-xs text-neutral-500">Click {settings.control === "stop" ? "Stop" : "Give way"} again to swap which roads have it.</p>
        )}
      </fieldset>

      {settings.control === "signals" && !settings.roundabout && (
        <Switch
          label={`${engine.graph.drivingSide === "right" ? "Right" : "Left"} turn on red`}
          icon={<CornerUpRight size={15} className={`text-neutral-400 ${engine.graph.drivingSide === "left" ? "-scale-x-100" : ""}`} aria-hidden />}
          checked={!!settings.turnOnRed}
          onChange={(on) => update({ turnOnRed: on || undefined })}
        />
      )}

      <Switch
        label="Roundabout"
        icon={<RefreshCw size={15} className="text-neutral-400" aria-hidden />}
        checked={settings.roundabout}
        onChange={(roundabout) => update({ roundabout })}
      />

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

      <button
        type="button"
        disabled={settings.roundabout}
        onClick={() => {
          gameStore.getState().setJunctionOpen(null);
          gameStore.getState().setLaneEditNode(id);
        }}
        onMouseDown={keepFocusOnGame}
        className="flex items-center justify-between rounded-lg px-1 py-1 text-neutral-200 transition-colors duration-100 hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <span className="flex items-center gap-2">
          <GitMerge size={15} className="text-neutral-400" aria-hidden />
          Lane connector
        </span>
        <span className="text-xs text-neutral-500">
          {settings.roundabout ? "Not for roundabouts" : settings.connections ? "Custom" : "Default"}
        </span>
      </button>
    </OptionsPanel>
  );
}

/** Shown while connecting a junction's lanes: how it works, Reset (back to the defaults) and Done. */
export function LaneEditBar({ engine }: { engine: Engine | null }) {
  const id = useGame((s) => s.laneEditNode);
  if (!engine || id === null) return null;
  const button = "rounded-lg px-2.5 py-1 font-medium transition-colors duration-100 text-neutral-200 hover:bg-white/10 hover:text-white";
  return (
    <div
      role="dialog"
      aria-label="Lane connector"
      className="absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-white/10 bg-neutral-900/95 py-1.5 pl-3 pr-1.5 shadow-xl shadow-black/40 backdrop-blur"
    >
      <span className="text-neutral-300">
        <span className="font-semibold text-white">Lane connector:</span> click an amber lane end, then green lane starts to
        connect or disconnect them.
      </span>
      <button
        type="button"
        onClick={() => engine.graph.setJunction(id, { connections: undefined })}
        onMouseDown={keepFocusOnGame}
        className={button}
      >
        Reset
      </button>
      <button
        type="button"
        onClick={() => gameStore.getState().setLaneEditNode(null)}
        onMouseDown={keepFocusOnGame}
        className={`${button} bg-sky-500/90 text-white hover:bg-sky-500`}
      >
        Done
      </button>
    </div>
  );
}
