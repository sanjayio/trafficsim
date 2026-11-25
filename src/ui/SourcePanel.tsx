import { Check, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { BUILDING_LABEL, SOURCE_BUILDINGS, SOURCE_RATE, type Building, type Source } from "../core/terminal";
import type { Engine } from "../render/Engine";
import { gameStore } from "../state/store";
import { OptionsPanel, Switch } from "./OptionsPanel";
import { keepFocusOnGame } from "./Panel";

/** The source's settings, and every sink on the map (by node id, with its building), kept up to date. */
function useSource(engine: Engine, id: number): { source: Source | null; sinks: { node: number; building: Building }[] } {
  const read = () => {
    const terminal = engine.graph.terminal(id);
    const sinks = [...engine.graph.allTerminals()]
      .filter(([, t]) => t.kind === "sink")
      .map(([node, t]) => ({ node, building: t.building }));
    return { source: terminal?.kind === "source" ? terminal : null, sinks: sinks.sort((a, b) => a.node - b.node) };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    setState(read());
    return engine.graph.subscribe((e) => {
      if (e.type === "terminal-changed" || e.type === "reset") setState(read());
    });
    // `read` only depends on engine and id.
  }, [engine, id]);
  return state;
}

/** A source's options: on/off, its kind of home (which sets how many cars a minute), and which sinks its cars head to. */
export function SourcePanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const { source, sinks } = useSource(engine, id);
  // Stop pointing out a sink once the panel goes.
  useEffect(() => () => gameStore.getState().setHighlightNode(null), []);
  if (!source) return null;
  const update = (changes: Partial<Source>) => engine.graph.setTerminal(id, { ...source, ...changes });
  const toggleSink = (sink: number) =>
    update({ sinks: source.sinks.includes(sink) ? source.sinks.filter((s) => s !== sink) : [...source.sinks, sink] });

  return (
    <OptionsPanel title={BUILDING_LABEL[source.building]} x={x} y={y} height={220 + sinks.length * 30}>
      <Switch
        label="Sending cars"
        icon={<Power size={15} className="text-neutral-400" aria-hidden />}
        checked={source.enabled}
        onChange={(enabled) => update({ enabled })}
      />

      <div role="radiogroup" aria-label="Home" className="grid grid-cols-3 gap-1">
        {SOURCE_BUILDINGS.map((building) => (
          <button
            key={building}
            type="button"
            role="radio"
            aria-checked={source.building === building}
            onClick={() => update({ building, rate: SOURCE_RATE[building] })}
            onMouseDown={keepFocusOnGame}
            className={`flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium transition-colors duration-100 ${
              source.building === building ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            {BUILDING_LABEL[building]}
            <span className="tabular-nums opacity-75">{SOURCE_RATE[building]}/min</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Destinations</span>
        {sinks.length === 0 ? (
          <p className="px-1 text-xs text-neutral-500">No shops or offices yet. Add one with the Traffic tool (4).</p>
        ) : (
          <>
            <SinkRow label="Any shop or office" checked={source.sinks.length === 0} onClick={() => update({ sinks: [] })} />
            {sinks.map(({ node, building }, i) => (
              <SinkRow
                key={node}
                label={`${BUILDING_LABEL[building]} ${i + 1}`}
                checked={source.sinks.includes(node)}
                onClick={() => toggleSink(node)}
                onHover={(on) => gameStore.getState().setHighlightNode(on ? node : null)}
              />
            ))}
          </>
        )}
      </div>
    </OptionsPanel>
  );
}

function SinkRow({
  label,
  checked,
  onClick,
  onHover,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  onHover?: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onClick}
      onMouseDown={keepFocusOnGame}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className="flex items-center gap-2 rounded-lg px-1 py-1 text-left text-neutral-200 transition-colors duration-100 hover:bg-white/5"
    >
      <span
        className={`grid size-4 place-items-center rounded border ${
          checked ? "border-sky-500 bg-sky-500 text-white" : "border-white/25"
        }`}
      >
        {checked && <Check size={12} strokeWidth={3} aria-hidden />}
      </span>
      {label}
    </button>
  );
}
