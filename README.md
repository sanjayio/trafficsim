# Road Builder

Road builder and traffic simulator. three.js renders the world with a perspective orbit camera; React draws the HUD; Tauri v2 wraps it as a desktop app. It also runs as a plain web app.

## Run

```sh
pnpm install
pnpm tauri dev   # desktop app
pnpm dev         # browser only, http://localhost:1420
pnpm tauri build # release bundle
```

## Controls

In the app: ☰ menu (top right) → **Controls**. That list is generated from `src/ui/controls.ts`; update it when changing bindings.

| Input | Action |
| --- | --- |
| `1` / `2` / `3` / `4` | Select / Road / Bulldoze / Traffic |
| Road → Straight / Curve / Complex curve | Click start → end; start → bend → end; or start → bend → bend → end. A preview follows the cursor; it turns red if the bend is too tight for the road |
| Road → Continuous | Click start → end, then each further click extends the road with a smooth curve. Right-click or `Esc` ends it |
| Road → magnet toggle | Snap onto road ends, onto roads (making a T-junction), to guidelines (road extensions and perpendiculars, 45° steps from your start) and their crossings. A readout by the cursor shows length and angle |
| Road → parallel toggle, `[` / `]` | Also build a parallel copy, offset left or right (a one-way copy runs the opposite way) |
| Road → `1` `2` `3` buttons | Lanes per direction (total lanes for a one-way road) |
| Road → one-way / median / footpath toggles | One-way roads flow from your first click to your second. A median applies to two-way roads only |
| Road → snap-to-grid toggle (grid icon) | Snap endpoints to the grid (default) or place them freely. Either way, clicking near an existing road end attaches to it |
| Hold `Alt` / `Option` (Road) | Place freely: flips grid snapping and turns off guides and angles |
| Bulldoze → one by one / area | Click a road to remove it, or drag a rectangle to remove every road it touches (`Esc` / right-click abandons the drag) |
| Traffic → a building, click the zoning tiles | The Traffic tool shows zoning tiles beside every road (left out where they'd overlap a road, belong to a nearer road, or crowd a junction). Hover to see the tiles the chosen building takes: green where it fits, red where it doesn't; click to place it, facing the road. Homes are sources: villa (1 car a minute, 2×2 tiles), townhouse (4, 3×2), apartment (12, 3×3). Shops and offices are sinks, where cars head: small shop and small office (2×2), large shop (4×3), large office (3×3). Click a building to remove it, or with another building selected to swap. Saved with the map |
| Hover a home → ⚙ (or click it with Select) | Home options: on/off, the kind of home (which sets its cars a minute), and destinations (any shop or office, or chosen ones) |
| Hover a junction → ⚙ (or click it with Select) | Junction options: control (none / give way / stop / signals), roundabout, corner smoothness, lane connector. Saved with the map |
| Junction options → Lane connector | Click an incoming lane's end (amber), then outgoing lanes' starts (green) to connect or disconnect them; cars only drive connected lanes, and the painted lane arrows follow. Reset restores the defaults; `Esc` or Done leaves. Changing a road at the junction resets it |
| ☰ → Settings → Driving side | Right- or left-hand traffic (decides which lanes get stop lines, and later which lanes cars use). Saved with the map |
| Crossing or ending on a road | Forms a junction: both roads are split there. Too-shallow crossings (< 20°) or ones leaving tiny road pieces show red and can't be built |
| Click (Bulldoze) | Remove the highlighted road |
| Wheel / pinch | Zoom at cursor |
| `R` / `F` | Zoom in / out at the screen centre (hold `Shift` for faster) |
| `W` `A` `S` `D` / arrow keys | Pan (hold `Shift` for faster) |
| `Q` / `E` | Rotate anticlockwise / clockwise around the screen centre (hold `Shift` for faster) |
| `T` / `G` | Tilt the camera towards 30° (3D view) / back to 90° top-down |
| Right- or middle-drag (left-drag in Select) | Pan |
| `Space` | Pause / resume |
| Autosave | The map is kept in the browser as you build and comes back on your next visit. ☰ → New map starts afresh; Save map / Open map still save and load files |
| Radio (top middle) | Internet radio from Radio Paradise (Main Mix, Mellow, Rock, Global): play/stop, station and volume. Remembers your station and volume |
| Right-click / `Esc` | Step back one point / cancel the road in progress |

## Layout

```
src/
  core/       Pure simulation + data: RoadGraph, routing, car tracks, Simulation (fixed 60 Hz step). No three.js, no Tauri.
  render/     three.js: Engine (renderer, loop, input routing), Camera (orbit + ground ray casts), RoadLayer, Grid, OverlayLayer.
  tools/      Build tools (Road, Bulldoze, Select) — turn world-space pointer input into graph edits.
              Renderer-agnostic: previews go through the `Overlay` interface.
  platform/   Tauri vs browser differences (file open/save). Only place that imports Tauri plugins.
  state/      Zustand store shared by the HUD (hooks) and the engine (getState/subscribe).
  ui/         React HUD overlaid on the canvas.
src-tauri/    Rust shell. Plugins: dialog, fs. Permissions in capabilities/default.json.
```

Rules of thumb:

- React never renders the scene. The engine is mounted once and talks to the UI through the store.
- Build meshes when data changes, never rebuild them every frame.
- Ground items are flat at y = 0, drawn in a fixed order (`FlatLayer`) with depth writes off, so they never z-fight. 3D objects use normal depth.
- Simulation logic only ever sees the fixed `SIM_DT`; sim speed changes how many steps run per frame.
