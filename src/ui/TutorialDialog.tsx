import {
  Camera,
  Building2,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Map as MapIcon,
  MousePointer2,
  Road,
  Settings2,
  Tractor,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { KeyCombo } from "./ControlsDialog";
import { CONTROL_GROUPS, type ControlRow } from "./controls";
import { Dialog } from "./Dialog";
import { keepFocusOnGame } from "./Panel";
import { TutorialScene } from "./TutorialScenes";

/** What each group of controls is for, in a sentence, with an icon (by the group's title in `controls.ts`). */
const INTRO: Record<string, { icon: LucideIcon; text: string }> = {
  Tools: {
    icon: MousePointer2,
    text: "Three tools sit at the bottom left: pick one with its button or its number key. With Road or Buildings, the bulldozer beside them (B) removes roads or buildings.",
  },
  "Building roads": {
    icon: Road,
    text: "With the Road tool, choose a shape, the lanes and any extras above the tools, then click on the map. Guides and the magnet snap ends onto roads and neat angles.",
  },
  Junctions: {
    icon: Settings2,
    text: "Where three or more roads meet, hover for the ⚙ button: give way, stop or signals, a roundabout, corner smoothness, and the lane connector.",
  },
  Buildings: {
    icon: Building2,
    text: "Homes send cars out to shops and offices along the fastest route. Place them on the tiles that line every road.",
  },
  Bulldozing: {
    icon: Tractor,
    text: "Turn on the bulldozer beside the tools: with the Road tool it clears roads, with Buildings it clears buildings. One by one, or by dragging a box.",
  },
  Camera: { icon: Camera, text: "Move round the city, turn it, zoom and tilt for a 3D view." },
  Simulation: { icon: Gauge, text: "Pause, or speed time up, with the buttons at the bottom right." },
};

interface Slide {
  title: string;
  icon: LucideIcon;
  text: string;
  rows: ControlRow[];
}

/** A welcome, then one slide per group of controls (from the same list as the Controls dialog, so they agree). */
const SLIDES: Slide[] = [
  {
    title: "Welcome to TrafficSim",
    icon: MapIcon,
    text: "Draw roads, set up the junctions where they meet, and put homes, shops and offices beside them. Cars then drive between them on their own. This tour shows the controls for each part.",
    rows: [],
  },
  ...CONTROL_GROUPS.map((group) => ({
    title: group.title,
    icon: INTRO[group.title]?.icon ?? MapIcon,
    text: INTRO[group.title]?.text ?? "",
    rows: group.rows,
  })),
];

/** A slideshow of the controls and shortcuts. Opened from the main menu and the New map dialog. */
export function TutorialDialog({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const go = useCallback((step: number) => setIndex((i) => Math.max(0, Math.min(SLIDES.length - 1, i + step))), []);
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    },
    [go],
  );
  const slide = SLIDES[index];
  const last = index === SLIDES.length - 1;
  const Icon = slide.icon;

  return (
    <Dialog title="Tutorial" onClose={onClose} onKey={onKey}>
      {/* Keyed by slide, so it slides in afresh and its picture starts from the beginning. */}
      <section key={index} className="tut-enter flex min-h-80 flex-col gap-4" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-sky-500/15 text-sky-400">
            <Icon size={20} aria-hidden />
          </span>
          <div>
            <div className="text-xs text-neutral-500">
              {index + 1} of {SLIDES.length}
            </div>
            <h3 className="text-base font-semibold text-white">{slide.title}</h3>
          </div>
        </div>
        <TutorialScene title={slide.title} />
        <p className="text-neutral-300">{slide.text}</p>
        {slide.rows.length > 0 && (
          <dl className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            {slide.rows.map((row) => (
              <div key={row.action} className="flex items-baseline justify-between gap-4">
                <dt className="text-neutral-300">{row.action}</dt>
                <dd className="flex shrink-0 items-center gap-1">
                  <KeyCombo keys={row.keys} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <div className="flex items-center justify-between">
        <div className="flex gap-1.5" role="tablist" aria-label="Slides">
          {SLIDES.map((s, i) => (
            <button
              key={s.title}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={s.title}
              onClick={() => setIndex(i)}
              onMouseDown={keepFocusOnGame}
              className={`h-1.5 rounded-full transition-all duration-150 ${i === index ? "w-5 bg-sky-400" : "w-1.5 bg-white/25 hover:bg-white/40"}`}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => go(-1)}
            onMouseDown={keepFocusOnGame}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 font-medium text-neutral-300 transition-colors duration-100 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft size={16} aria-hidden />
            Back
          </button>
          <button
            type="button"
            onClick={() => (last ? onClose() : go(1))}
            onMouseDown={keepFocusOnGame}
            className="flex items-center gap-1 rounded-lg bg-sky-500/90 px-3 py-1.5 font-medium text-white transition-colors duration-100 hover:bg-sky-500"
          >
            {last ? "Done" : "Next"}
            {!last && <ChevronRight size={16} aria-hidden />}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
