import { Check, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { MAX_SOURCE_RATE, type Source } from "../core/terminal";
import type { Engine } from "../render/Engine";
import { gameStore } from "../state/store";
import { OptionsPanel, Switch } from "./OptionsPanel";
import { keepFocusOnGame } from "./Panel";

/** The source's settings, and every sink on the map (by node id), kept up to date. */
function useSource(engine: Engine, id: number): { source: Source | null; sinks: number[] } {
  const read = () => {
    const terminal = engine.graph.terminal(id);
    const sinks = [...engine.graph.allTerminals()].filter(([, t]) => t.kind === "sink").map(([node]) => node);
    return { source: terminal?.kind === "source" ? terminal : null, sinks: sinks.sort((a, b) => a - b) };
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

/** A source's options: on/off, how many cars per minute, and which sinks its cars head to. */
export function SourcePanel({ engine, id, x, y }: { engine: Engine; id: number; x: number; y: number }) {
  const { source, sinks } = useSource(engine, id);
  // Stop pointing out a sink once the panel goes.
  useEffect(() => () => gameStore.getState().setHighlightNode(null), []);
  if (!source) return null;
  const update = (changes: Partial<Source>) => engine.graph.setTerminal(id, { ...source, ...changes });
  const toggleSink = (sink: number) =>
    update({ sinks: source.sinks.includes(sink) ? source.sinks.filter((s) => s !== sink) : [...source.sinks, sink] });

  return (
    <OptionsPanel title="Source" x={x} y={y} height={200 + sinks.length * 30}>
      <Switch
        label="Sending cars"
        icon={<Power size={15} className="text-neutral-400" aria-hidden />}
        checked={source.enabled}
        onChange={(enabled) => update({ enabled })}
      />

      <label className="flex flex-col gap-1.5 px-1">
        <span className="flex justify-between text-neutral-200">
          Cars per minute
          <span className="tabular-nums text-neutral-400">{source.rate}</span>
        </span>
        <input
          type="range"
          min={1}
          max={MAX_SOURCE_RATE}
          step={1}
          value={source.rate}
          onChange={(e) => update({ rate: Number(e.target.value) })}
          // Hand keyboard focus back to the game once the slider is let go.
          onPointerUp={(e) => e.currentTarget.blur()}
          className="w-full accent-sky-500"
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Destinations</span>
        {sinks.length === 0 ? (
          <p className="px-1 text-xs text-neutral-500">No sinks yet. Add one with the Traffic tool (4).</p>
        ) : (
          <>
            <SinkRow label="Any sink" checked={source.sinks.length === 0} onClick={() => update({ sinks: [] })} />
            {sinks.map((sink, i) => (
              <SinkRow
                key={sink}
                label={`Sink ${i + 1}`}
                checked={source.sinks.includes(sink)}
                onClick={() => toggleSink(sink)}
                onHover={(on) => gameStore.getState().setHighlightNode(on ? sink : null)}
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
