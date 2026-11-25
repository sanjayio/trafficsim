import { Check } from "lucide-react";
import { useGame } from "../state/store";

const AUTOSAVE_TEXT = { saving: "Saving…", saved: "Saved", failed: "Not saved" };

export function StatusBar() {
  const fps = useGame((s) => s.stats.fps);
  const autosave = useGame((s) => s.autosave);

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
        <span>{fps} fps</span>
      </div>
    </div>
  );
}
