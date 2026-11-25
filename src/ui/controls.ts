import { IS_MAC } from "./platform";

/**
 * Every input the game understands, shown in the Controls dialog. Keep this in sync
 * with Camera, Engine, RoadTool and Toolbar when adding or changing bindings.
 *
 * `keys` entries render as key caps, except the separators "/", "+" and "or".
 */
export interface ControlRow {
  keys: string[];
  action: string;
}

export interface ControlGroup {
  title: string;
  rows: ControlRow[];
}

const ALT = IS_MAC ? "⌥ Option" : "Alt";

export const CONTROL_SEPARATORS = new Set(["/", "+", "or"]);

export const CONTROL_GROUPS: ControlGroup[] = [
  {
    title: "Tools",
    rows: [
      { keys: ["1"], action: "Select" },
      { keys: ["2"], action: "Road" },
      { keys: ["3"], action: "Bulldoze" },
    ],
  },
  {
    title: "Building roads",
    rows: [
      { keys: ["Click"], action: "Straight: click the start, then the end" },
      { keys: ["Click"], action: "Curve: start, bend point, end" },
      { keys: ["Click"], action: "Complex curve: start, two bend points, end" },
      { keys: ["Click"], action: "Continuous: start, end, then click to keep extending smoothly" },
      { keys: ["Right-click"], action: "Step back one point (ends a continuous road)" },
      { keys: ["Esc"], action: "Cancel the road in progress" },
      { keys: ["[", "/", "]"], action: "Move the parallel road left / right" },
      { keys: [ALT], action: "Hold to place freely (flips grid snapping, turns off guides)" },

    ],
  },
  {
    title: "Junctions",
    rows: [
      { keys: ["Hover"], action: "Show a junction's ⚙ options button (Select tool, or Road tool between roads)" },
      { keys: ["Click"], action: "Select tool: open a junction's options" },
      { keys: ["Esc"], action: "Close junction options" },
    ],
  },
  {
    title: "Bulldozing",
    rows: [
      { keys: ["Click"], action: "One by one: remove the highlighted road" },
      { keys: ["Drag"], action: "Area: remove every road the rectangle touches" },
      { keys: ["Esc", "or", "Right-click"], action: "Abandon an area selection" },
    ],
  },
  {
    title: "Camera",
    rows: [
      { keys: ["W", "A", "S", "D", "or", "Arrows"], action: "Pan" },
      { keys: ["Right-drag", "or", "Middle-drag"], action: "Pan (left-drag also pans with Select)" },
      { keys: ["Q", "/", "E"], action: "Rotate anticlockwise / clockwise" },
      { keys: ["R", "/", "F", "or", "Wheel"], action: "Zoom in / out" },
      { keys: ["T", "/", "G"], action: "Tilt towards 3D / back to top-down" },
      { keys: ["Shift"], action: "Hold for faster camera keys" },
    ],
  },
  {
    title: "Simulation",
    rows: [{ keys: ["Space"], action: "Pause / resume" }],
  },
];
