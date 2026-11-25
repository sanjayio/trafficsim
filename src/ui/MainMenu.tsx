import { Coffee, FilePlus, FolderOpen, GraduationCap, Heart, Keyboard, Menu, Save, Settings, Star, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Engine } from "../render/Engine";
import { gameStore, useGame } from "../state/store";
import { keepFocusOnGame, Panel } from "./Panel";

/** The Support button's links: tips for the game's maker, and a star for its repo. */
const SUPPORT_LINKS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: "Buy me a coffee", href: "https://ko-fi.com/sssanjay", icon: Coffee },
  // GitHub has no link that stars a repo; its page has the Star button at the top.
  { label: "Star on GitHub", href: "https://github.com/sanjayio/trafficsim", icon: Star },
];

/** Top-right ☰ menu: map file actions, settings and the controls reference. Also shows short status messages. */
export function MainMenu({
  engine,
  onNewMap,
  onShowSettings,
  onShowControls,
  onShowTutorial,
}: {
  onShowTutorial: () => void;
  onNewMap: () => void;
  engine: Engine | null;
  onShowSettings: () => void;
  onShowControls: () => void;
}) {
  // Which dropdown is open: the ☰ menu, the Support links, or neither.
  const [open, setOpen] = useState<"menu" | "support" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const message = useGame((s) => s.message);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => gameStore.getState().showMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  // Close on any press outside the menu, or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const runFileAction = async (action: () => Promise<boolean>, success: string) => {
    try {
      if (await action()) gameStore.getState().showMessage(success);
    } catch (err) {
      gameStore.getState().showMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const choose = (action: () => void) => () => {
    setOpen(null);
    action();
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-2">
      <div className="flex gap-2">
        <Panel>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open === "support"}
            onClick={() => setOpen((o) => (o === "support" ? null : "support"))}
            onMouseDown={keepFocusOnGame}
            className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 font-medium transition-colors duration-100 ${
              open === "support" ? "bg-white/15 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Heart size={16} className="text-rose-400" aria-hidden />
            Support
          </button>
        </Panel>
        <Panel>
          <button
            type="button"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={open === "menu"}
            onClick={() => setOpen((o) => (o === "menu" ? null : "menu"))}
            onMouseDown={keepFocusOnGame}
            className={`grid size-9 place-items-center rounded-lg transition-colors duration-100 ${
              open === "menu" ? "bg-white/15 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Menu size={18} aria-hidden />
          </button>
        </Panel>
      </div>

      {open === "support" && (
        <div
          role="menu"
          aria-label="Support"
          className="pointer-events-auto mr-11 flex w-48 origin-top-right flex-col rounded-xl border border-white/10 bg-neutral-900/95 p-1 shadow-xl shadow-black/40 backdrop-blur"
        >
          {SUPPORT_LINKS.map(({ label, href, icon: Icon }) => (
            <a
              key={href}
              role="menuitem"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(null)}
              onMouseDown={keepFocusOnGame}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-neutral-200 transition-colors duration-100 hover:bg-white/10 hover:text-white"
            >
              <Icon size={16} className="text-neutral-400" aria-hidden />
              {label}
            </a>
          ))}
        </div>
      )}

      {open === "menu" && (
        <div
          role="menu"
          aria-label="Main menu"
          className="pointer-events-auto flex w-48 origin-top-right flex-col rounded-xl border border-white/10 bg-neutral-900/95 p-1 shadow-xl shadow-black/40 backdrop-blur"
        >
          <MenuItem
            icon={FilePlus}
            label="New map"
            disabled={!engine}
            onSelect={choose(onNewMap)}
          />
          <MenuItem
            icon={FolderOpen}
            label="Open map…"
            disabled={!engine}
            onSelect={choose(() => runFileAction(() => engine!.openMap(), "Map loaded"))}
          />
          <MenuItem
            icon={Save}
            label="Save map…"
            disabled={!engine}
            onSelect={choose(() => runFileAction(() => engine!.saveMap(), "Map saved"))}
          />
          <div role="separator" className="my-1 h-px bg-white/10" />
          <MenuItem icon={Settings} label="Settings" onSelect={choose(onShowSettings)} />
          <MenuItem icon={Keyboard} label="Controls" onSelect={choose(onShowControls)} />
          <MenuItem icon={GraduationCap} label="Tutorial" onSelect={choose(onShowTutorial)} />
        </div>
      )}

      {message && !open && (
        <div
          role="status"
          className="rounded-lg border border-white/10 bg-neutral-900/90 px-3 py-1.5 text-neutral-200 shadow-lg"
        >
          {message}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  disabled,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      onMouseDown={keepFocusOnGame}
      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-neutral-200 transition-colors duration-100 hover:bg-white/10 hover:text-white disabled:opacity-40"
    >
      <Icon size={16} className="text-neutral-400" aria-hidden />
      {label}
    </button>
  );
}
