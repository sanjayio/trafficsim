import { GraduationCap } from "lucide-react";
import { useState } from "react";
import { MAX_MAP_NAME, type DrivingSide } from "../core/roadGraph";
import type { Engine } from "../render/Engine";
import { useGame } from "../state/store";
import { Dialog } from "./Dialog";
import { keepFocusOnGame } from "./Panel";

const DRIVING_SIDES: { id: DrivingSide; label: string }[] = [
  { id: "right", label: "Right-hand" },
  { id: "left", label: "Left-hand" },
];

/** Starts a new map: its name, and which side of the road traffic drives on. */
export function NewMapDialog({
  engine,
  onClose,
  onShowTutorial,
}: {
  engine: Engine;
  onClose: () => void;
  onShowTutorial: () => void;
}) {
  const [name, setName] = useState("New city");
  const [side, setSide] = useState<DrivingSide>(useGame((s) => s.drivingSide));

  return (
    <Dialog title="New map" onClose={onClose}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          engine.newMap(name.trim(), side);
          onClose();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-neutral-200">Name</span>
          <input
            autoFocus
            value={name}
            maxLength={MAX_MAP_NAME}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-white outline-none focus:border-sky-500"
          />
        </label>

        <div className="flex items-center justify-between gap-4">
          <div>
            <div id="new-map-side" className="text-neutral-200">
              Driving side
            </div>
            <div className="text-xs text-neutral-500">Which side of the road traffic keeps to.</div>
          </div>
          <div role="radiogroup" aria-labelledby="new-map-side" className="flex shrink-0 rounded-lg border border-white/10 bg-white/5 p-0.5">
            {DRIVING_SIDES.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={side === id}
                onClick={() => setSide(id)}
                onMouseDown={keepFocusOnGame}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors duration-100 ${
                  side === id ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-neutral-500">The current map is replaced. Save it to a file first if you want to keep it.</p>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onShowTutorial}
            className="mr-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-neutral-300 transition-colors duration-100 hover:bg-white/10 hover:text-white"
          >
            <GraduationCap size={16} aria-hidden />
            Tutorial
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 font-medium text-neutral-300 transition-colors duration-100 hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-sky-500/90 px-3 py-1.5 font-medium text-white transition-colors duration-100 hover:bg-sky-500">
            Create map
          </button>
        </div>
      </form>
    </Dialog>
  );
}
