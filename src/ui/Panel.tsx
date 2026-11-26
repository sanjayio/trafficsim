import type { MouseEvent, ReactNode } from "react";

/** HUD controls shouldn't take keyboard focus, or game keys (Space, WASD...) would also activate them. */
export const keepFocusOnGame = (e: MouseEvent) => e.preventDefault();

export function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`pointer-events-auto flex items-center gap-1 rounded-xl border border-white/10 bg-neutral-900/80 p-1 shadow-lg shadow-black/30 backdrop-blur ${className}`}
    >
      {children}
    </div>
  );
}

const buttonStateClass = (active: boolean) =>
  active ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white";

export function PanelButton({
  active = false,
  title,
  onClick,
  disabled,
  children,
}: {
  active?: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseDown={keepFocusOnGame}
      disabled={disabled}
      className={`flex h-9 items-center rounded-lg px-3 font-medium transition-colors duration-100 disabled:opacity-40 ${buttonStateClass(active)}`}
    >
      {children}
    </button>
  );
}

/**
 * Square icon button with a hover label above it. `pressed` makes it a toggle
 * (tool selection, on/off options) and is announced to screen readers.
 */
export function IconButton({
  label,
  pressed,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Tinted red, for a destructive tool. */
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const state = danger
    ? pressed
      ? "bg-red-500/90 text-white"
      : "text-red-400 hover:bg-red-500/20 hover:text-red-300"
    : buttonStateClass(!!pressed);
  return (
    <span className="group relative flex">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        onMouseDown={keepFocusOnGame}
        className={`grid size-9 place-items-center rounded-lg transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35 ${state}`}
      >
        {children}
      </button>
      {/* Left-aligned so labels on buttons at the screen edge aren't clipped. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-0 mb-2 whitespace-nowrap rounded-md border border-white/10 bg-neutral-950/95 px-2 py-1 text-xs text-neutral-200 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-hover:delay-300"
      >
        {label}
      </span>
    </span>
  );
}
