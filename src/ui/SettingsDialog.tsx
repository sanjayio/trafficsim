import type { DrivingSide } from "../core/roadGraph";
import type { Engine } from "../render/Engine";
import { gameStore, useGame } from "../state/store";
import { Dialog } from "./Dialog";
import { keepFocusOnGame } from "./Panel";
import { TrafficRulesSettings } from "./TrafficRules";

const DRIVING_SIDES: { id: DrivingSide; label: string }[] = [
  { id: "right", label: "Right-hand" },
  { id: "left", label: "Left-hand" },
];

/** Game settings. Opened from the main menu. */
export function SettingsDialog({ engine, onClose }: { engine: Engine | null; onClose: () => void }) {
  const drivingSide = useGame((s) => s.drivingSide);
  return (
    <Dialog title="Settings" onClose={onClose}>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Traffic</h3>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div id="driving-side-label" className="text-neutral-200">
              Driving side
            </div>
            <div className="text-xs text-neutral-500">Which side of the road traffic keeps to. Saved with the map.</div>
          </div>
          <div
            role="radiogroup"
            aria-labelledby="driving-side-label"
            className="flex shrink-0 rounded-lg border border-white/10 bg-white/5 p-0.5"
          >
            {DRIVING_SIDES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={drivingSide === id}
                onClick={() => gameStore.getState().setDrivingSide(id)}
                onMouseDown={keepFocusOnGame}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors duration-100 ${
                  drivingSide === id ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>
      {engine && <TrafficRulesSettings engine={engine} />}
    </Dialog>
  );
}
