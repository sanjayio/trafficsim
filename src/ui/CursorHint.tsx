import { HINT_OFFSET } from "../render/Engine";
import { useGame } from "../state/store";

/** Room the readout needs beside the cursor before it flips to the other side, in pixels. */
const FLIP_MARGIN_X = 160;
const FLIP_MARGIN_Y = 40;

/** Small readout that follows the cursor, e.g. a road's length and angle while drawing. */
export function CursorHint() {
  const hint = useGame((s) => s.hint);
  if (!hint) return null;
  // Near the right or bottom edge, show it on the other side of the cursor instead of clipping.
  const flipX = hint.x + FLIP_MARGIN_X > window.innerWidth;
  const flipY = hint.y + FLIP_MARGIN_Y > window.innerHeight;
  const dx = flipX ? `calc(-100% - ${HINT_OFFSET * 2}px)` : "0px";
  const dy = flipY ? `calc(-100% - ${HINT_OFFSET * 2}px)` : "0px";
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md border border-white/10 bg-neutral-950/85 px-2 py-0.5 text-xs tabular-nums text-neutral-100 shadow-lg"
      style={{ transform: `translate(${hint.x}px, ${hint.y}px) translate(${dx}, ${dy})` }}
    >
      {hint.text}
    </div>
  );
}
