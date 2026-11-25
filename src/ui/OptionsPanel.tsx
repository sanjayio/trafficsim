import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { gameStore } from "../state/store";
import { keepFocusOnGame } from "./Panel";

export const PANEL_WIDTH = 264;
const EDGE = 12;

/**
 * The options panel for a junction or source: beside its anchor point (kept inside the window),
 * with a title and a close button. Escape or the button closes it.
 */
export function OptionsPanel({
  title,
  x,
  y,
  height,
  children,
}: {
  title: string;
  x: number;
  y: number;
  /** Rough height, to keep the panel inside the window. */
  height: number;
  children: ReactNode;
}) {
  const close = () => gameStore.getState().setJunctionOpen(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") gameStore.getState().setJunctionOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const left = Math.min(Math.max(EDGE, x + 28), window.innerWidth - PANEL_WIDTH - EDGE);
  const top = Math.min(Math.max(EDGE, y - height / 2), window.innerHeight - height - EDGE);

  return (
    <div
      role="dialog"
      aria-label={`${title} options`}
      className="absolute flex flex-col gap-3 rounded-xl border border-white/10 bg-neutral-900/95 p-3 shadow-xl shadow-black/40 backdrop-blur"
      style={{ left, top, width: PANEL_WIDTH }}
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">{title}</h2>
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
      {children}
    </div>
  );
}

/** A labelled on/off switch row. */
export function Switch({
  label,
  icon,
  checked,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      onMouseDown={keepFocusOnGame}
      className="flex items-center justify-between rounded-lg px-1 py-1 text-neutral-200 transition-colors duration-100 hover:bg-white/5"
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${checked ? "bg-sky-500" : "bg-white/20"}`}>
        <span
          className={`absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow transition-transform duration-150 ${
            checked ? "translate-x-3" : ""
          }`}
        />
      </span>
    </button>
  );
}
