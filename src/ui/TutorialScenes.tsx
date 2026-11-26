import { Car, MousePointer2, Road, Tractor } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A small looping picture for each tutorial slide (by its title), showing what it teaches. Drawn in
 * the game's colours; the motion is CSS (see `tut-` in index.css), off for reduced motion.
 */
export function TutorialScene({ title }: { title: string }) {
  const scene = SCENES[title];
  if (!scene) return null;
  return (
    <div aria-hidden className="tut-scene overflow-hidden rounded-xl border border-white/10 bg-[#52803c]">
      {scene()}
    </div>
  );
}

const ASPHALT = "#3d4148";
const FOOTPATH = "#6f747b";
const LINE = "#d9b44a";
const ACCENT = "#38bdf8";

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 320 120" className="block aspect-[8/3] w-full">
      {children}
    </svg>
  );
}

/** A straight road from (x1, y) to (x2, y): footpaths, asphalt and a dashed centre line. */
function HRoad({ y, x1 = -10, x2 = 330 }: { y: number; x1?: number; x2?: number }) {
  return (
    <g>
      <rect x={x1} y={y - 16} width={x2 - x1} height={32} fill={FOOTPATH} />
      <rect x={x1} y={y - 12} width={x2 - x1} height={24} fill={ASPHALT} />
      <line x1={x1} y1={y} x2={x2} y2={y} stroke={LINE} strokeWidth={1.5} strokeDasharray="8 6" />
    </g>
  );
}

function VRoad({ x, y1 = -10, y2 = 130 }: { x: number; y1?: number; y2?: number }) {
  return (
    <g>
      <rect x={x - 16} y={y1} width={32} height={y2 - y1} fill={FOOTPATH} />
      <rect x={x - 12} y={y1} width={24} height={y2 - y1} fill={ASPHALT} />
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={LINE} strokeWidth={1.5} strokeDasharray="8 6" />
    </g>
  );
}

/** A car seen from above, its middle at the origin, pointing along +x. */
function CarShape({ color }: { color: string }) {
  return (
    <g>
      <rect x={-8} y={-4} width={16} height={8} rx={2} fill={color} />
      <rect x={-3} y={-3} width={6} height={6} rx={1} fill="#26323f" />
    </g>
  );
}

function House({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-12} y={-10} width={24} height={20} fill="#efe6d2" />
      <path d="M -14 -10 L 0 -20 L 14 -10 Z" fill="#c2553f" />
      <rect x={-12} y={-14} width={24} height={10} fill="#a8432f" opacity={0.6} />
    </g>
  );
}

function Shop({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-18} y={-12} width={36} height={24} fill="#e8e2d0" />
      <rect x={-18} y={4} width={36} height={6} fill="#2f9e8f" />
    </g>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  "Welcome to TrafficSim": () => (
    <Frame>
      <House x={50} y={28} />
      <House x={90} y={28} />
      <Shop x={250} y={100} />
      <HRoad y={64} />
      <g className="tut-drive-right">
        <g transform="translate(0 70)">
          <CarShape color="#f2f2f0" />
        </g>
      </g>
      <g className="tut-drive-right" style={{ animationDelay: "-2.6s" }}>
        <g transform="translate(0 70)">
          <CarShape color="#3f7fbf" />
        </g>
      </g>
      <g className="tut-drive-left" style={{ animationDelay: "-1.3s" }}>
        <g transform="translate(0 58) rotate(180)">
          <CarShape color="#c9a227" />
        </g>
      </g>
    </Frame>
  ),

  Tools: () => {
    // The three tools, then the bulldozer beside them (for Road and Traffic), each lit in turn.
    const tools: [typeof Car, string][] = [
      [MousePointer2, "1"],
      [Road, "2"],
      [Car, "3"],
      [Tractor, "B"],
    ];
    return (
      <div className="flex aspect-[8/3] items-center justify-center gap-3">
        {tools.map(([Icon, key], i) => (
          <div key={key} className={`flex flex-col items-center gap-1.5 ${i === 3 ? "ml-3" : ""}`}>
            <span
              className={`tut-tool grid size-11 place-items-center rounded-lg border border-white/10 bg-neutral-900/85 ${i === 3 ? "text-red-400" : "text-neutral-300"}`}
              style={{ animationDelay: `${i * 1.2}s` }}
            >
              <Icon size={20} aria-hidden />
            </span>
            <span className="rounded bg-neutral-900/70 px-1.5 text-[10px] font-semibold tabular-nums text-neutral-300">{key}</span>
          </div>
        ))}
      </div>
    );
  },

  "Building roads": () => {
    const d = "M 40 96 C 120 96 180 28 282 30";
    return (
      <Frame>
        <path d={d} pathLength={100} className="tut-draw" fill="none" stroke={FOOTPATH} strokeWidth={30} strokeLinecap="round" />
        <path d={d} pathLength={100} className="tut-draw" fill="none" stroke={ASPHALT} strokeWidth={22} strokeLinecap="round" />
        <path d={d} pathLength={100} className="tut-draw" fill="none" stroke={LINE} strokeWidth={1.5} />
        <circle cx={40} cy={96} r={5} fill={ACCENT} className="tut-click" />
        <circle cx={282} cy={30} r={5} fill={ACCENT} className="tut-click" style={{ animationDelay: "1.6s" }} />
      </Frame>
    );
  },

  Junctions: () => (
    <Frame>
      <HRoad y={60} />
      <VRoad x={160} />
      <rect x={144} y={44} width={32} height={32} fill={ASPHALT} />
      {/* East-west traffic moves on its green, north-south on the other. */}
      <g className="tut-cross-x">
        <g transform="translate(0 66)">
          <CarShape color="#f2f2f0" />
        </g>
      </g>
      <g className="tut-cross-y">
        <g transform="translate(154 0) rotate(90)">
          <CarShape color="#9b1c1c" />
        </g>
      </g>
      {[
        [128, 82, "a"],
        [192, 38, "a"],
        [128, 38, "b"],
        [192, 82, "b"],
      ].map(([x, y, phase]) => (
        <g key={`${x}${y}`} transform={`translate(${x} ${y})`}>
          <rect x={-5} y={-9} width={10} height={18} rx={2} fill="#1b1d20" />
          <circle r={3.5} className={phase === "a" ? "tut-light-a" : "tut-light-b"} />
        </g>
      ))}
      {/* The junction's options button, off to the side so cars don't pass under it. */}
      <g transform="translate(110 20)">
        <g className="tut-pulse">
          <circle r={9} fill="#171717" opacity={0.9} />
          <circle r={3} fill="none" stroke="#e5e5e5" strokeWidth={1.5} />
        </g>
      </g>
    </Frame>
  ),

  Traffic: () => (
    <Frame>
      <HRoad y={84} />
      <rect x={44} y={40} width={12} height={32} fill={ASPHALT} />
      <rect x={264} y={40} width={12} height={32} fill={ASPHALT} />
      <House x={50} y={30} />
      <Shop x={270} y={28} />
      {[0, 1.7, 3.4].map((delay) => (
        <g key={delay} className="tut-trip" style={{ animationDelay: `${delay}s` }}>
          <CarShape color={delay ? (delay > 2 ? "#c9a227" : "#3f7fbf") : "#f2f2f0"} />
        </g>
      ))}
    </Frame>
  ),

  Bulldozing: () => (
    <Frame>
      <HRoad y={40} />
      <g className="tut-demolish">
        <VRoad x={200} y1={56} y2={130} />
        <Shop x={248} y={96} />
      </g>
      <rect
        x={176}
        y={52}
        width={100}
        height={64}
        fill="#e5484d"
        fillOpacity={0.18}
        stroke="#e5484d"
        strokeWidth={1.5}
        strokeDasharray="5 4"
        className="tut-select"
      />
    </Frame>
  ),

  Camera: () => (
    <Frame>
      <g className="tut-camera">
        <HRoad y={60} x1={-200} x2={520} />
        <VRoad x={100} y1={-200} y2={320} />
        <VRoad x={240} y1={-200} y2={320} />
        <House x={60} y={30} />
        <House x={140} y={30} />
        <House x={200} y={94} />
        <Shop x={290} y={28} />
        <Shop x={50} y={96} />
      </g>
    </Frame>
  ),

  Simulation: () => (
    <Frame>
      <HRoad y={78} />
      <g className="tut-speed">
        <g transform="translate(0 84)">
          <CarShape color="#3f7fbf" />
        </g>
      </g>
      {["❚❚", "1×", "2×", "4×"].map((label, i) => (
        <g key={label} transform={`translate(${196 + i * 30} 14)`}>
          <rect width={26} height={20} rx={5} className="tut-chip" style={{ animationDelay: `${i * 1.5}s` }} />
          <text x={13} y={14} textAnchor="middle" fontSize={10} fontWeight={600} fill="#e5e5e5">
            {label}
          </text>
        </g>
      ))}
    </Frame>
  ),
};
