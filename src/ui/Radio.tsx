import { Pause, Play, Radio as RadioIcon, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { gameStore, useGame } from "../state/store";
import { keepFocusOnGame } from "./Panel";

/** Radio Paradise: listener-supported, ad-free streams, played straight from their servers. */
const STATIONS = [
  { name: "Main Mix", url: "https://stream.radioparadise.com/mp3-128" },
  { name: "Mellow", url: "https://stream.radioparadise.com/mellow-128" },
  { name: "Rock", url: "https://stream.radioparadise.com/rock-128" },
  { name: "Global", url: "https://stream.radioparadise.com/global-128" },
];

const STORAGE_KEY = "radio";

/** The volume picked last time, remembered in this browser (if it lets us). The station is kept with the map's session. */
function remembered(): number {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Internet radio at the top middle of the screen: play/pause, station and volume. Starts only when
 * asked. Small (just play/pause) until hovered, or reached with the keyboard.
 */
export function Radio() {
  const audio = useRef<HTMLAudioElement>(null);
  // A station from a newer or older list falls back to the first.
  const picked = useGame((s) => s.station);
  const station = STATIONS[picked] ? picked : 0;
  const [volume, setVolume] = useState(remembered);
  const [state, setState] = useState<"off" | "connecting" | "playing" | "failed">("off");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume }));
    } catch {
      // Private windows and blocked storage just don't remember.
    }
  }, [volume]);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);

  const play = (index: number) => {
    const el = audio.current;
    if (!el) return;
    el.src = STATIONS[index].url;
    setState("connecting");
    el.play().catch(() => setState("failed"));
  };

  const stop = () => {
    const el = audio.current;
    if (!el) return;
    el.pause();
    // Drop the stream, so resuming picks it up live rather than from where it paused.
    el.removeAttribute("src");
    el.load();
    setState("off");
  };

  const status = { off: "Radio off", connecting: "Connecting…", playing: "On air", failed: "Couldn't connect" }[state];

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
      <div className="group pointer-events-auto flex items-center rounded-xl border border-white/10 bg-neutral-900/90 p-1 shadow-lg shadow-black/30 backdrop-blur">
        <audio
          ref={audio}
          preload="none"
          onPlaying={() => setState("playing")}
          onWaiting={() => setState((s) => (s === "off" ? s : "connecting"))}
          onError={() => setState((s) => (s === "off" ? s : "failed"))}
        />
        <button
          type="button"
          aria-label={state === "off" || state === "failed" ? "Play radio" : "Stop radio"}
          onClick={() => (state === "off" || state === "failed" ? play(station) : stop())}
          onMouseDown={keepFocusOnGame}
          className={`grid size-8 place-items-center rounded-lg transition-colors duration-100 ${
            state === "playing" || state === "connecting" ? "bg-sky-500/90 text-white" : "text-neutral-200 hover:bg-white/10"
          }`}
        >
          {state === "off" || state === "failed" ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />}
        </button>
        <span className="relative mx-1.5 grid place-items-center">
          <RadioIcon size={14} className="text-neutral-500" aria-hidden />
          {state === "playing" && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-emerald-400" aria-hidden />}
        </span>
        <div className="flex max-w-0 items-center gap-2 overflow-hidden whitespace-nowrap transition-[max-width] duration-200 ease-out group-focus-within:max-w-md group-focus-within:pr-2 group-hover:max-w-md group-hover:pr-2">
          <select
            aria-label="Station"
            value={station}
            onChange={(e) => {
              const next = Number(e.target.value);
              gameStore.getState().setStation(next);
              if (state !== "off") play(next);
              // Hand keyboard focus back to the game.
              e.currentTarget.blur();
            }}
            className="cursor-pointer rounded-md bg-transparent py-1 text-neutral-100 outline-none hover:bg-white/5"
          >
            {STATIONS.map((s, i) => (
              <option key={s.url} value={i} className="bg-neutral-900">
                {s.name}
              </option>
            ))}
          </select>
          <span
            className={`w-24 text-xs ${state === "failed" ? "text-red-400" : state === "playing" ? "text-emerald-400" : "text-neutral-500"}`}
            aria-live="polite"
          >
            {status}
          </span>
          <Volume2 size={14} className="text-neutral-500" aria-hidden />
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={(e) => e.currentTarget.blur()}
            className="w-20 accent-sky-500"
          />
        </div>
      </div>
    </div>
  );
}
