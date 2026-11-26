import { Power, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BUILDING_LABEL,
  defaultName,
  DESTINATIONS,
  destinationsOf,
  LEVEL_NEEDS,
  levelOf,
  MAX_LEVEL,
  MAX_NAME,
  type Destinations,
  type Source,
  type Terminal,
} from "../core/terminal";
import { usualColors } from "../render/buildings";
import type { Engine } from "../render/Engine";
import { gameStore } from "../state/store";
import { OptionsPanel, Switch } from "./OptionsPanel";
import { keepFocusOnGame } from "./Panel";

/** A shop's or office's name: its own, or the one it's given until it has one (homes have none). */
const nameOf = (t: Terminal, node: number) => (t.kind === "sink" ? t.name || defaultName(t.building, node) : "");

/**
 * The building's settings, and every shop and office on the map (by node id, with its name), kept
 * up to date. Customers served change without an event, so it's read again every second too.
 */
function useBuilding(engine: Engine, id: number): { terminal: Terminal | null; sinks: { node: number; name: string }[] } {
  const read = () => {
    const terminal = engine.graph.terminal(id) ?? null;
    const sinks = [...engine.graph.allTerminals()]
      .filter(([, t]) => t.kind === "sink")
      .map(([node, t]) => ({ node, name: nameOf(t, node) }));
    return { terminal: terminal && { ...terminal }, sinks: sinks.sort((a, b) => a.node - b.node) };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    setState(read());
    const timer = setInterval(() => setState(read()), 1000);
    const unsubscribe = engine.graph.subscribe((e) => {
      if (e.type === "terminal-changed" || e.type === "reset") setState(read());
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
    // `read` only depends on engine and id.
  }, [engine, id]);
  return state;
}

/**
 * A building's options: its name (on its sign), colours and level, and for a home whether it's
 * sending cars, its kind of home (which sets how many cars a minute) and which shops and offices
 * its cars head to.
 */
export function BuildingPanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const { terminal, sinks } = useBuilding(engine, id);
  // Stop pointing out a shop once the panel goes.
  useEffect(() => () => gameStore.getState().setHighlightNode(null), []);
  if (!terminal) return null;
  const home = terminal.kind === "source";

  return (
    <OptionsPanel title={BUILDING_LABEL[terminal.building]} x={x} y={y} height={home ? 400 : 210}>
      <Details engine={engine} id={id} terminal={terminal} />
      {home && <HomeOptions engine={engine} id={id} source={terminal} sinks={sinks} />}
    </OptionsPanel>
  );
}

/** Name, colours and level: for every building. */
function Details({ engine, id, terminal }: { engine: Engine; id: number; terminal: Terminal }) {
  const [name, setName] = useState(nameOf(terminal, id));
  useEffect(() => setName(nameOf(terminal, id)), [terminal.name, id]);
  const update = (changes: Partial<Terminal>) => engine.graph.setTerminal(id, { ...engine.graph.terminal(id)!, ...changes } as Terminal);
  const commitName = () => {
    if (terminal.kind !== "sink") return;
    const trimmed = name.trim().slice(0, MAX_NAME);
    update({ name: trimmed && trimmed !== defaultName(terminal.building, id) ? trimmed : undefined });
  };
  const colors = terminal.colors ?? usualColors(terminal.building, engine.graph.terminalLot(id)?.centre ?? { x: 0, y: 0 });
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  const setColour = (role: "primary" | "secondary", value: string) => update({ colors: { ...colors, [role]: parseInt(value.slice(1), 16) } });
  const level = levelOf(terminal);
  const served = terminal.served ?? 0;
  const needed = LEVEL_NEEDS[level] ?? null;
  const from = LEVEL_NEEDS[level - 1];
  const progress = needed === null ? 1 : (served - from) / (needed - from);
  const unit = terminal.kind === "source" ? "trips" : "customers";

  return (
    <div className="flex flex-col gap-2">
      {terminal.kind === "sink" && (
      <input
        aria-label="Name"
        value={name}
        maxLength={MAX_NAME}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          // Keep typing out of the game's shortcuts; Enter or Esc finishes.
          e.stopPropagation();
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-sky-500"
      />
      )}
      <div className="flex items-center gap-3 px-1 text-xs text-neutral-400">
        {(["primary", "secondary"] as const).map((role) => (
          <label key={role} className="flex items-center gap-1.5">
            <input
              type="color"
              aria-label={role === "primary" ? "Main colour" : "Accent colour"}
              value={hex(colors[role])}
              onChange={(e) => setColour(role, e.target.value)}
              className="size-6 cursor-pointer rounded border border-white/15 bg-transparent"
            />
            {role === "primary" ? "Main" : "Accent"}
          </label>
        ))}
        {terminal.colors && (
          <button type="button" onClick={() => update({ colors: undefined })} onMouseDown={keepFocusOnGame} className="ml-auto text-sky-400 hover:text-sky-300">
            Reset
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-medium text-neutral-200">
            Level {level} <span className="text-neutral-500">/ {MAX_LEVEL}</span>
          </span>
          <span className="tabular-nums text-neutral-400">
            {needed === null ? "Top level" : `${needed - served} more ${unit}`}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-label="To next level">
          <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

const DESTINATION_LABEL: Record<Destinations, string> = { any: "Any", shops: "Shops", offices: "Offices", custom: "Custom" };

/** A home's traffic: on/off, how many cars it sends, and where they go (any, shops, offices, or ones picked by name). */
function HomeOptions({ engine, id, source, sinks }: { engine: Engine; id: number; source: Source; sinks: { node: number; name: string }[] }) {
  // From the building as it is now (the panel's copy can be a second old: a level since then would be undone).
  const update = (changes: Partial<Source>) => engine.graph.setTerminal(id, { ...(engine.graph.terminal(id) as Source), ...changes });
  const to = destinationsOf(source);
  const picked = sinks.filter((s) => source.sinks.includes(s.node));

  return (
    <>
      <Switch
        label={`Sending cars · ${Math.round(source.rate * 10) / 10}/min`}
        icon={<Power size={15} className="text-neutral-400" aria-hidden />}
        checked={source.enabled}
        onChange={(enabled) => update({ enabled })}
      />

      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Destinations</span>
        <div role="radiogroup" aria-label="Destinations" className="grid grid-cols-4 gap-1">
          {DESTINATIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={to === d}
              onClick={() => update({ to: d })}
              onMouseDown={keepFocusOnGame}
              className={`rounded-lg py-1.5 text-xs font-medium transition-colors duration-100 ${
                to === d ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {DESTINATION_LABEL[d]}
            </button>
          ))}
        </div>
        {to === "custom" && (
          <>
            <div className="flex flex-wrap gap-1">
              {picked.map(({ node, name }) => (
                <span
                  key={node}
                  onMouseEnter={() => gameStore.getState().setHighlightNode(node)}
                  onMouseLeave={() => gameStore.getState().setHighlightNode(null)}
                  className="flex items-center gap-1 rounded-full bg-sky-500/20 py-0.5 pl-2 pr-1 text-xs text-sky-100"
                >
                  {name}
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => update({ sinks: source.sinks.filter((s) => s !== node) })}
                    onMouseDown={keepFocusOnGame}
                    className="grid size-4 place-items-center rounded-full hover:bg-white/15"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <PickByName
              options={sinks.filter((s) => !source.sinks.includes(s.node))}
              onPick={(node) => update({ sinks: [...source.sinks, node] })}
            />
            {picked.length === 0 && <p className="px-1 text-xs text-neutral-500">No cars go out until you pick a shop or office.</p>}
          </>
        )}
      </div>
    </>
  );
}

/** A text field that suggests shops and offices by name as you type; picking one adds it. Highlights the hovered one on the map. */
function PickByName({ options, onPick }: { options: { node: number; name: string }[]; onPick: (node: number) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const matches = options.filter((o) => o.name.toLowerCase().includes(text.trim().toLowerCase())).slice(0, 6);
  const pick = (node: number) => {
    onPick(node);
    setText("");
    gameStore.getState().setHighlightNode(null);
  };
  return (
    <div className="relative">
      <input
        aria-label="Add a shop or office"
        placeholder={options.length ? "Add a shop or office…" : "No more shops or offices"}
        disabled={!options.length}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Late enough that a click on a suggestion lands first.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          // Keep typing out of the game's shortcuts.
          e.stopPropagation();
          if (e.key === "Enter" && matches[0]) pick(matches[0].node);
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-sky-500 disabled:opacity-50"
      />
      {open && matches.length > 0 && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-white/10 bg-neutral-900 shadow-lg shadow-black/40">
          {matches.map(({ node, name }) => (
            <li key={node} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(node)}
                onMouseEnter={() => gameStore.getState().setHighlightNode(node)}
                onMouseLeave={() => gameStore.getState().setHighlightNode(null)}
                className="w-full px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-white/10"
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
