import {
  ArrowBigUp,
  Briefcase,
  Building as BuildingIcon,
  Building2,
  Hotel,
  House,
  ShoppingCart,
  Store,
  ChevronLeft,
  ChevronRight,
  Equal,
  Footprints,
  TreeDeciduous,
  Grid3x3,
  Magnet,
  Play,
  MousePointer2,
  MousePointerClick,
  Road,
  SeparatorVertical,
  SquareDashedMousePointer,
  Slash,
  Spline,
  Tractor,
  Waypoints,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { DEFAULT_SPEED, MAX_LANES, SPEED_LIMITS } from "../core/roadSpec";
import { MAX_LEVEL } from "../core/grade";
import { useEffect, type ReactNode } from "react";
import { gameStore, isSnapping, useGame, type SimSpeed, type ToolId } from "../state/store";
import type { BulldozeMode, RoadMode } from "../tools/Tool";
import { BUILDING_LABEL, isSourceBuilding, SINK_BUILDINGS, SOURCE_BUILDINGS, SOURCE_RATE, SOURCE_RATE_MAX, type Building } from "../core/terminal";
import { IconButton, keepFocusOnGame, Panel, PanelButton } from "./Panel";

const TOOLS: { id: ToolId; label: string; key: string; icon: LucideIcon }[] = [
  { id: "select", label: "Select", key: "1", icon: MousePointer2 },
  { id: "road", label: "Road", key: "2", icon: Road },
  { id: "traffic", label: "Buildings", key: "3", icon: Building2 },
];

/** A bridge, drawn in the lucide style: a deck on two arches. */
function BridgeIcon({ size = 24, strokeWidth = 2, ...props }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 9h20" />
      <path d="M4 9v10M20 9v10M12 9v10" />
      <path d="M4 19a4 4 0 0 1 8 0M12 19a4 4 0 0 1 8 0" />
    </svg>
  );
}

/** A tunnel portal, drawn in the lucide style: an arch into a hillside. */
function TunnelIcon({ size = 24, strokeWidth = 2, ...props }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 20 9 6l5 5 3-3 5 12z" />
      <path d="M9 20v-4a3 3 0 0 1 6 0v4" />
    </svg>
  );
}

const SPEEDS: { speed: SimSpeed; label: string }[] = [
  { speed: 0, label: "❚❚" },
  { speed: 1, label: "1×" },
  { speed: 2, label: "2×" },
  { speed: 4, label: "4×" },
];

const ICON_SIZE = 18;

/** A single arc in the lucide style, for the simple (one bend point) curve mode. */
function CurveIcon({ size = 24, strokeWidth = 2, ...props }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 19C6 9 18 9 20 19" />
      <circle cx="12" cy="6" r="1.5" />
    </svg>
  );
}

const ROAD_MODES: { id: RoadMode; label: string; icon: LucideIcon | typeof CurveIcon }[] = [
  { id: "straight", label: "Straight", icon: Slash },
  { id: "curve", label: "Curve", icon: CurveIcon },
  { id: "complex", label: "Complex curve", icon: Spline },
  { id: "continuous", label: "Continuous", icon: Waypoints },
];

export function Toolbar() {
  const tool = useGame((s) => s.tool);
  const bulldozing = useGame((s) => s.bulldozing);
  // Bulldozing belongs to the Road tool (roads) and the Buildings tool (buildings).
  const canBulldoze = tool === "road" || tool === "traffic";
  const speed = useGame((s) => s.speed);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      const match = TOOLS.find((t) => t.key === e.key);
      if (match) gameStore.getState().setTool(match.id);
      if (e.key === "b" || e.key === "B") gameStore.getState().setBulldozing(!gameStore.getState().bulldozing);
      const { tool, parallel, nudgeParallelOffset } = gameStore.getState();
      if (tool === "road" && parallel && (e.key === "[" || e.key === "]")) nudgeParallelOffset(e.key === "]" ? 1 : -1);
      // A step up (a bridge higher, a tunnel shallower) or down, through the ground: for laying roads and bulldozing them.
      if (tool === "road" && ["+", "=", "-", "_"].includes(e.key)) {
        const { roadSpec, updateRoadSpec } = gameStore.getState();
        const level = Math.max(-MAX_LEVEL, Math.min(MAX_LEVEL, (roadSpec.level ?? 0) + (e.key === "+" || e.key === "=" ? 1 : -1)));
        updateRoadSpec({ level: level || undefined });
      }
      if (e.code === "Space") {
        e.preventDefault();
        gameStore.getState().togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // Above the status bar: tools bottom-left (options stacked above them), simulation speed bottom-right.
    <div className="pointer-events-none absolute inset-x-3 bottom-12 flex items-end justify-between gap-2">
      {/* Each tool's options float above its own button group, without widening it. */}
      <div className="flex items-end gap-2">
        <div className="relative">
          <div className="absolute bottom-full left-0 mb-2 w-max">
            {tool === "road" && !bulldozing && <RoadOptions />}
            {tool === "traffic" && !bulldozing && <TrafficOptions />}
          </div>
          <Panel>
            {TOOLS.map(({ id, label, icon: Icon }) => (
              <IconButton key={id} label={label} pressed={tool === id} onClick={() => gameStore.getState().setTool(id)}>
                <Icon size={ICON_SIZE} strokeWidth={2} aria-hidden />
              </IconButton>
            ))}
          </Panel>
        </div>
        {/* Bulldoze stands apart, tinted red: it destroys. Roads with the Road tool, buildings with Traffic. */}
        {canBulldoze && (
          <div className="relative">
            <div className="absolute bottom-full left-0 mb-2 w-max">{bulldozing && <BulldozeOptions />}</div>
            <Panel>
              <IconButton
                label={tool === "road" ? "Bulldoze roads" : "Bulldoze buildings"}
                danger
                pressed={bulldozing}
                onClick={() => gameStore.getState().setBulldozing(!bulldozing)}
              >
                <Tractor size={ICON_SIZE} strokeWidth={2} aria-hidden />
              </IconButton>
            </Panel>
          </div>
        )}
      </div>
      <Panel>
        {SPEEDS.map((s) => (
          <PanelButton
            key={s.speed}
            active={speed === s.speed}
            title={s.speed === 0 ? (speed === 0 ? "Play" : "Pause") : `Speed ${s.label}`}
            // The pause button plays again (at the last speed) while paused.
            onClick={() => (s.speed === 0 ? gameStore.getState().togglePause() : gameStore.getState().setSpeed(s.speed))}
          >
            {s.speed === 0 && speed === 0 ? <Play size={14} fill="currentColor" aria-hidden /> : <span className="tabular-nums">{s.label}</span>}
          </PanelButton>
        ))}
      </Panel>
    </div>
  );
}

const BULLDOZE_MODES: { id: BulldozeMode; label: string; icon: LucideIcon }[] = [
  { id: "single", label: "One by one", icon: MousePointerClick },
  { id: "area", label: "Area: drag to select", icon: SquareDashedMousePointer },
];

/** Second-level options shown while the Bulldoze tool is active. */
function BulldozeOptions() {
  const mode = useGame((s) => s.bulldozeMode);
  const tool = useGame((s) => s.tool);
  const level = useGame((s) => s.roadSpec.level ?? 0);
  return (
    <Panel>
      {BULLDOZE_MODES.map(({ id, label, icon: Icon }) => (
        <IconButton key={id} label={label} pressed={mode === id} onClick={() => gameStore.getState().setBulldozeMode(id)}>
          <Icon size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
      ))}
      {/* Roads are bulldozed at the Road tool's step (+ and - change it). */}
      {tool === "road" && <span className="whitespace-nowrap px-2 text-xs text-neutral-300">{stepName(level)}</span>}
    </Panel>
  );
}

/** A step as said in the toolbar: the ground, or a bridge's or tunnel's step. */
const stepName = (level: number) => (level > 0 ? `Bridge: step ${level}` : level < 0 ? `Tunnel: step ${-level}` : "Ground");

const BUILDING_ICON: Record<Building, LucideIcon> = {
  villa: House,
  apartment: BuildingIcon,
  smallShop: Store,
  largeShop: ShoppingCart,
  smallOffice: Briefcase,
  largeOffice: Hotel,
};

/** Second-level options shown while the Buildings tool is active: homes (sources), then shops and offices (sinks). */
function TrafficOptions() {
  const mode = useGame((s) => s.trafficMode);
  const button = (b: Building) => {
    const Icon = BUILDING_ICON[b];
    const label = isSourceBuilding(b)
      ? `${BUILDING_LABEL[b]}: ${SOURCE_RATE[b]}–${SOURCE_RATE_MAX[b]} cars a minute, rising as it levels up`
      : `${BUILDING_LABEL[b]}: cars head here`;
    return (
      <IconButton key={b} label={label} pressed={mode === b} onClick={() => gameStore.getState().setTrafficMode(b)}>
        <Icon size={ICON_SIZE} strokeWidth={2} aria-hidden />
      </IconButton>
    );
  };
  return (
    <Panel className="flex-col !items-stretch">
      <Row label="Homes">{SOURCE_BUILDINGS.map(button)}</Row>
      <RowDivider />
      <Row label="Shops & offices">{SINK_BUILDINGS.map(button)}</Row>
    </Panel>
  );
}

/** The parallel road toggle, and while it's on, the copy's offset. */
function ParallelOptions() {
  const parallel = useGame((s) => s.parallel);
  const offset = useGame((s) => s.parallelOffset);
  const side = offset > 0 ? "right" : "left";
  return (
    <>
      <IconButton label="Parallel road" pressed={parallel} onClick={() => gameStore.getState().setParallel(!parallel)}>
        <Equal size={ICON_SIZE} strokeWidth={2} className="-rotate-45" aria-hidden />
      </IconButton>
      {parallel && (
        <div className="flex items-center" role="group" aria-label={`Parallel offset: ${Math.abs(offset)} to the ${side}`}>
          <StepButton label="Move parallel road left" onClick={() => gameStore.getState().nudgeParallelOffset(-1)}>
            <ChevronLeft size={16} aria-hidden />
          </StepButton>
          <span className="w-11 text-center text-xs font-medium tabular-nums text-neutral-200">
            {Math.abs(offset)} {offset > 0 ? "R" : "L"}
          </span>
          <StepButton label="Move parallel road right" onClick={() => gameStore.getState().nudgeParallelOffset(1)}>
            <ChevronRight size={16} aria-hidden />
          </StepButton>
        </div>
      )}
    </>
  );
}

/** A bridge's or tunnel's next step from `step` (0: off): 1, 2, 3, then off. */
const nextStep = (step: number): number | undefined => (step >= MAX_LEVEL ? undefined : step + 1);

/** The step a bridge or tunnel is set to, in the corner of its button. */
function StepBadge({ step }: { step: number }) {
  return <span className="absolute -right-0.5 -top-0.5 grid size-3.5 place-items-center rounded-full bg-white text-[9px] font-bold leading-none text-sky-600">{step}</span>;
}

/** Second-level options shown while the Road tool is active. */
function RoadOptions() {
  // Shows the effective state, so holding Alt/Option visibly flips it. Clicking flips the setting.
  const snapping = useGame(isSnapping);
  const spec = useGame((s) => s.roadSpec);
  const update = gameStore.getState().updateRoadSpec;
  const bridge = Math.max(0, spec.level ?? 0);
  const tunnel = Math.max(0, -(spec.level ?? 0));
  const laneWord = (n: number) => `${n} lane${n === 1 ? "" : "s"}`;

  const mode = useGame((s) => s.roadMode);
  const guideSnapping = useGame((s) => s.guideSnapping);
  const inverted = useGame((s) => s.snapInverted);
  return (
    <Panel className="flex-col !items-stretch">
      <Row label="Road shape">
        {ROAD_MODES.map(({ id, label, icon: Icon }) => (
          <IconButton key={id} label={label} pressed={mode === id} onClick={() => gameStore.getState().setRoadMode(id)}>
            <Icon size={ICON_SIZE} strokeWidth={2} aria-hidden />
          </IconButton>
        ))}
        <ParallelOptions />
      </Row>
      <RowDivider />
      <Row label="Lanes">
        {Array.from({ length: MAX_LANES }, (_, i) => i + 1).map((n) => (
          <IconButton
            key={n}
            label={spec.oneWay ? laneWord(n) : `${laneWord(n)} each way`}
            pressed={spec.lanes === n}
            onClick={() => update({ lanes: n })}
          >
            <span className="text-sm font-semibold tabular-nums">{n}</span>
          </IconButton>
        ))}
      </Row>
      <RowDivider />
      <Row label="Speed limit">
        {SPEED_LIMITS.map((speed) => (
          <IconButton
            key={speed}
            label={`Speed limit: ${speed} km/h`}
            pressed={(spec.speed ?? DEFAULT_SPEED) === speed}
            onClick={() => update({ speed: speed === DEFAULT_SPEED ? undefined : speed })}
          >
            <span className="grid size-6 place-items-center rounded-full border-[2.5px] border-red-500 bg-white text-[10px] font-bold tabular-nums text-neutral-900">
              {speed}
            </span>
          </IconButton>
        ))}
      </Row>
      <RowDivider />
      <Row label="Road features">
        <IconButton label="One-way" pressed={spec.oneWay} onClick={() => update({ oneWay: !spec.oneWay })}>
          <ArrowBigUp size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
        {/* Nobody walks in a tunnel, and there's no median down one: those are off while laying one. */}
        <IconButton
          label={tunnel ? "Median (not in tunnels)" : spec.oneWay ? "Median (two-way roads only)" : "Median"}
          pressed={spec.median && !spec.oneWay && !tunnel}
          disabled={spec.oneWay || tunnel > 0}
          onClick={() => update({ median: !spec.median })}
        >
          <SeparatorVertical size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
        <IconButton
          label={tunnel ? "Footpath (not in tunnels)" : "Footpath"}
          pressed={spec.footpath && !tunnel}
          disabled={tunnel > 0}
          onClick={() => update({ footpath: !spec.footpath })}
        >
          <Footprints size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
        <IconButton
          label={tunnel ? "Street trees (not in tunnels)" : spec.footpath ? "Street trees" : "Street trees (roads with footpaths only)"}
          pressed={!!spec.trees && spec.footpath && !tunnel}
          disabled={!spec.footpath || tunnel > 0}
          onClick={() => update({ trees: !spec.trees })}
        >
          <TreeDeciduous size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
        {/* Each click a step higher (or deeper), then off: the height the road is built at, all along. */}
        <IconButton label={bridge ? `Bridge: step ${bridge}` : "Bridge"} pressed={bridge > 0} onClick={() => update({ level: nextStep(bridge) })}>
          <BridgeIcon size={ICON_SIZE} strokeWidth={2} aria-hidden />
          {bridge > 0 && <StepBadge step={bridge} />}
        </IconButton>
        <IconButton label={tunnel ? `Tunnel: step ${tunnel}` : "Tunnel"} pressed={tunnel > 0} onClick={() => update({ level: -(nextStep(tunnel) ?? 0) || undefined })}>
          <TunnelIcon size={ICON_SIZE} strokeWidth={2} aria-hidden />
          {tunnel > 0 && <StepBadge step={tunnel} />}
        </IconButton>
      </Row>
      <RowDivider />
      <Row label="Snapping">
        {/* Holding Alt/Option switches guides off, and the button shows it. */}
        <IconButton
          label={`Snap to roads, guidelines and angles: ${guideSnapping && !inverted ? "on" : "off"}`}
          pressed={guideSnapping && !inverted}
          onClick={() => gameStore.getState().setGuideSnapping(!guideSnapping)}
        >
          <Magnet size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
        <IconButton
          label={`Snap to grid: ${snapping ? "on" : "off"}`}
          pressed={snapping}
          onClick={() => {
            const { snapToGrid, setSnapToGrid } = gameStore.getState();
            setSnapToGrid(!snapToGrid);
          }}
        >
          <Grid3x3 size={ICON_SIZE} strokeWidth={2} aria-hidden />
        </IconButton>
      </Row>
    </Panel>
  );
}

/** One row of the road options: a group of related buttons, titled. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      <span aria-hidden className="px-1.5 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function RowDivider() {
  return <span aria-hidden className="mx-1 h-px bg-white/10" />;
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onMouseDown={keepFocusOnGame}
      className="grid h-9 w-6 place-items-center rounded-md text-neutral-400 transition-colors duration-100 hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  );
}
