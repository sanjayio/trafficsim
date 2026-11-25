import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { keepFocusOnGame } from "./Panel";

/** Modal dialog over the game: closes on Escape, the × button or a click outside. */
export function Dialog({
  title,
  onClose,
  onKey,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Sees the dialog's key presses (they're kept from the game while it's open). */
  onKey?: (e: KeyboardEvent) => void;
  children: ReactNode;
}) {
  // While open, swallow key presses before the game's window listeners see them
  // (camera, tools, pause), and close on Escape. Key releases still pass through,
  // so a key held when the dialog opened doesn't stay stuck.
  const handle = onKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === "Escape") onClose();
      else handle?.(e);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, handle]);

  const titleId = `dialog-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black/40 p-4 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl shadow-black/50"
      >
        <div className="flex items-center justify-between border-b border-white/10 py-3 pl-5 pr-3">
          <h2 id={titleId} className="text-base font-semibold text-white">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            onMouseDown={keepFocusOnGame}
            className="grid size-8 place-items-center rounded-lg text-neutral-400 transition-colors duration-100 hover:bg-white/10 hover:text-white"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
