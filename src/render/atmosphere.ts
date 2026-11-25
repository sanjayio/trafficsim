import { Color } from "three";
import type { Weather } from "../state/store";

/** How the world looks at a time of day in some weather: sky, sun, haze, light and precipitation. */
export interface Atmosphere {
  /** Unit vector towards the sun (three.js axes, y up); below the horizon at night. */
  sun: { x: number; y: number; z: number };
  zenith: Color;
  /** Sky at the horizon, and the haze distant things fade into. */
  horizon: Color;
  /** Overall brightness of the scene (lights are exempt). */
  exposure: number;
  /** Colour cast over the scene: warm at golden hour, blue at night. */
  tint: Color;
  clouds: { cover: number; color: Color; speed: number };
  /** How bright the stars are (0 by day). */
  stars: number;
  /** How visible the sun's disc and glow are. */
  sunGlow: number;
  precipitation: "none" | "rain";
  /** Sideways drift of the rain. */
  wind: number;
  /** How far one sees before the haze (1 clear; less in rain). */
  visibility: number;
  /** How dark the sun's shadows are (0 at night, faint under heavy cloud). */
  shadow: number;
  /** How dark cloud shadows on the ground are (0 under a clear or night sky). */
  cloudShade: number;
  /** How much the lights are on: 0 by day, 1 once it's dark (from just before sunset). */
  night: number;
}

/** Looks at key sun heights (sine of its elevation), blended between. */
const KEYS = [
  { at: -0.3, zenith: 0x050915, horizon: 0x111a2e, exposure: 0.32, tint: 0x8ea4ff },
  { at: -0.08, zenith: 0x1b2448, horizon: 0x4a3a5c, exposure: 0.45, tint: 0xb4a8e6 },
  { at: 0.02, zenith: 0x34497a, horizon: 0xe58a52, exposure: 0.7, tint: 0xffc49a },
  { at: 0.2, zenith: 0x4f7cc0, horizon: 0xf0c48e, exposure: 0.9, tint: 0xffe2c4 },
  { at: 0.45, zenith: 0x3f7fd0, horizon: 0xbfd6e6, exposure: 1, tint: 0xffffff },
];

const WEATHER: Record<
  Weather,
  { cover: number; speed: number; grey: number; dim: number; sky: number; precipitation: Atmosphere["precipitation"]; wind: number; visibility: number }
> = {
  sunny: { cover: 0.35, speed: 4, grey: 0, dim: 1, sky: 1, precipitation: "none", wind: 0, visibility: 1 },
  cloudy: { cover: 0.78, speed: 6, grey: 0.55, dim: 0.85, sky: 0.86, precipitation: "none", wind: 0.1, visibility: 0.9 },
  rain: { cover: 0.95, speed: 9, grey: 0.75, dim: 0.7, sky: 0.6, precipitation: "rain", wind: 0.15, visibility: 0.6 },
  windy: { cover: 0.5, speed: 30, grey: 0.15, dim: 0.95, sky: 0.97, precipitation: "none", wind: 0.6, visibility: 1 },
};

const tmp = new Color();

export function atmosphere(hours: number, weather: Weather): Atmosphere {
  // The sun rises at 6, is highest (60°) at noon, and sets at 18; it swings from east to west.
  const day = ((hours - 6) / 12) * Math.PI;
  const height = Math.sin(day) * Math.sin((60 * Math.PI) / 180);
  const across = Math.cos(day);
  const flat = Math.sqrt(Math.max(0, 1 - height * height));
  const sun = { x: across * flat, y: height, z: -Math.sqrt(Math.max(0, 1 - across * across)) * flat * 0.6 };
  const norm = Math.hypot(sun.x, sun.y, sun.z) || 1;

  let i = 0;
  while (i < KEYS.length - 2 && height > KEYS[i + 1].at) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (height - a.at) / (b.at - a.at)));
  const mix = (p: number, q: number) => new Color(p).lerp(tmp.set(q), t);
  const w = WEATHER[weather];
  // Overcast: towards a grey of the same brightness, and darker under heavy cloud.
  const overcast = (c: Color) => c.lerp(tmp.setScalar((c.r + c.g + c.b) / 3), w.grey).multiplyScalar(w.sky);
  const zenith = overcast(mix(a.zenith, b.zenith));
  const horizon = overcast(mix(a.horizon, b.horizon));
  const light = Math.min(1, Math.max(0, (height + 0.15) / 0.35));
  return {
    sun: { x: sun.x / norm, y: sun.y / norm, z: sun.z / norm },
    zenith,
    horizon,
    exposure: (a.exposure + (b.exposure - a.exposure) * t) * w.dim,
    tint: mix(a.tint, b.tint).lerp(tmp.setScalar(1), w.grey),
    // Lit white by day, warmed by a low sun, dark at night; greyer under heavy cloud.
    clouds: {
      cover: w.cover,
      color: new Color(0x2a3040).lerp(tmp.set(0xffffff), light).lerp(horizon, 0.35).multiplyScalar(w.sky),
      speed: w.speed,
    },
    stars: Math.min(1, Math.max(0, -height / 0.15)) * (1 - w.cover * 0.8),
    sunGlow: (1 - w.cover * 0.85) * Math.min(1, Math.max(0, (height + 0.05) / 0.1)),
    precipitation: w.precipitation,
    wind: w.wind,
    visibility: w.visibility,
    // Long, soft shadows from a low sun; gone once it sets.
    shadow: 0.42 * Math.min(1, Math.max(0, height / 0.1)) * (1 - w.cover * 0.75),
    night: Math.min(1, Math.max(0, (0.08 - height) / 0.14)),
    cloudShade: 0.4 * Math.min(1, Math.max(0, (w.cover - 0.3) / 0.4)) * Math.min(1, Math.max(0, height / 0.15)),
  };
}
