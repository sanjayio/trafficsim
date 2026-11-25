/**
 * Platform layer: the only place that knows whether we're in the Tauri desktop
 * shell or a plain browser. Everything else calls these functions.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MAP_FILTER = { name: "Road map", extensions: ["json"] };

/** Prompts for a location and writes the map, named after it. Returns false if the user cancelled. */
export async function saveMapFile(contents: string, name: string): Promise<boolean> {
  // A file name from the map's name: letters, digits, spaces, dashes and underscores only.
  const fileName = `${name.replace(/[^\w\- ]+/g, "").trim() || "map"}.json`;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: fileName, filters: [MAP_FILTER] });
    if (!path) return false;
    await writeTextFile(path, contents);
    return true;
  }

  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
  URL.revokeObjectURL(url);
  return true;
}

/** Prompts for a map file and returns its contents, or null if the user cancelled. */
export async function openMapFile(): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: [MAP_FILTER] });
    return path ? readTextFile(path) : null;
  }

  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), {
      type: "file",
      accept: ".json,application/json",
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      resolve(file ? file.text() : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

const AUTOSAVE_KEY = "road-builder:map";
/** How the map was last seen (camera, time of day, weather): kept apart from the map, which files save. */
const VIEW_KEY = "road-builder:view";

/** The map kept in this browser (or desktop app) between visits, if there is one. */
export function loadAutosave(): string | null {
  try {
    return localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    // Storage blocked (some private windows): nothing kept.
    return null;
  }
}

/** Keeps the map in this browser for next time. False if it couldn't (storage blocked or full). */
export function saveAutosave(contents: string): boolean {
  try {
    localStorage.setItem(AUTOSAVE_KEY, contents);
    return true;
  } catch {
    return false;
  }
}

/** How the map was last seen, if kept. */
export function loadView(): string | null {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

/** Keeps how the map is seen for next visit (quietly does nothing if storage is blocked or full). */
export function saveView(contents: string): void {
  try {
    localStorage.setItem(VIEW_KEY, contents);
  } catch {
    // Nothing lost but the view.
  }
}
