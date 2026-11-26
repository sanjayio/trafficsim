import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_RULES, matchingPreset, PRESETS, presetRules, RULE_SECTIONS, type RuleField, type TrafficRules } from "../core/rules";
import type { Engine } from "../render/Engine";
import { Switch } from "./OptionsPanel";
import { keepFocusOnGame } from "./Panel";

/** The map's traffic rules, kept current as they change (or another map loads). */
function useRules(engine: Engine): TrafficRules {
  const [rules, setRules] = useState(() => engine.graph.rules);
  useEffect(() => {
    setRules(engine.graph.rules);
    return engine.graph.subscribe((e) => {
      if (e.type === "rules" || e.type === "reset") setRules(engine.graph.rules);
    });
  }, [engine]);
  return rules;
}

/** Settings for the map's traffic rules: a preset to start from, then every rule by section. Changes apply at once. */
export function TrafficRulesSettings({ engine }: { engine: Engine }) {
  const rules = useRules(engine);
  const preset = matchingPreset(rules);
  const set = (field: RuleField, value: unknown) =>
    engine.graph.setRules({ ...rules, [field.section]: { ...rules[field.section], [field.key]: value } });

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Traffic rules{preset === null && <span className="ml-2 normal-case tracking-normal text-sky-300">Custom</span>}
        </h3>
        <p className="text-xs text-neutral-500">How cars drive, give way and choose their way. Saved with the map; changes apply at once.</p>
      </div>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Preset" className="grid flex-1 grid-cols-4 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              onClick={() => engine.graph.setRules(presetRules(p.id))}
              onMouseDown={keepFocusOnGame}
              className={`rounded-md px-2 py-1 text-sm font-medium transition-colors duration-100 ${
                preset === p.id ? "bg-sky-500/90 text-white" : "text-neutral-300 hover:text-white"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => engine.graph.setRules(DEFAULT_RULES)}
          onMouseDown={keepFocusOnGame}
          disabled={preset === "standard"}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-neutral-300 transition-colors duration-100 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <RotateCcw size={14} aria-hidden />
          Reset
        </button>
      </div>
      {RULE_SECTIONS.map(({ section, title, fields }) => (
        <details key={section} className="group rounded-lg border border-white/10 bg-white/[0.03]">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-neutral-200">
            {title}
            <ChevronDown size={15} className="text-neutral-500 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="flex flex-col gap-3 border-t border-white/10 px-3 py-3">
            {fields.map((field) => (
              <Field key={field.key} field={field} value={(rules[section] as unknown as Record<string, unknown>)[field.key]} onChange={(v) => set(field, v)} />
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

function Field({ field, value, onChange }: { field: RuleField; value: unknown; onChange: (value: unknown) => void }) {
  const help = <span className="text-xs text-neutral-500">{field.help}</span>;
  if (field.kind === "toggle") {
    return (
      <div className="flex flex-col">
        <Switch label={field.label} icon={null} checked={value as boolean} onChange={onChange} />
        <span className="px-1">{help}</span>
      </div>
    );
  }
  if (field.kind === "number") {
    return (
      <label className="flex flex-col gap-1 px-1">
        <span className="flex justify-between text-neutral-200">
          {field.label}
          <span className="tabular-nums text-neutral-400">
            {value as number} {field.unit}
          </span>
        </span>
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value as number}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-sky-500"
        />
        {help}
      </label>
    );
  }
  const order = value as string[];
  const move = (i: number, by: number) => {
    const next = [...order];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1 px-1">
      <span className="text-neutral-200">{field.label}</span>
      {help}
      <ol className="mt-1 flex flex-col gap-1">
        {order.map((item, i) => (
          <li key={item} className="flex items-center gap-2 rounded-md bg-white/5 py-1 pl-2 pr-1 text-neutral-200">
            <span className="w-4 tabular-nums text-neutral-500">{i + 1}</span>
            <span className="flex-1">{field.items[item]}</span>
            <button
              type="button"
              aria-label={`Move ${field.items[item]} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
              onMouseDown={keepFocusOnGame}
              className="grid size-6 place-items-center rounded text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronUp size={14} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Move ${field.items[item]} down`}
              disabled={i === order.length - 1}
              onClick={() => move(i, 1)}
              onMouseDown={keepFocusOnGame}
              className="grid size-6 place-items-center rounded text-neutral-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronDown size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
