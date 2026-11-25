/**
 * Platform layer: the only place that knows whether we're in the Tauri desktop
 * shell or a plain browser. Everything else calls these functions.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MAP_FILTER = { name: "Road map", extensions: ["json"] };

/** Prompts for a location and writes the map. Returns false if the user cancelled. */
export async function saveMapFile(contents: string): Promise<boolean> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: "map.json", filters: [MAP_FILTER] });
    if (!path) return false;
    await writeTextFile(path, contents);
    return true;
  }

  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "map.json" });
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
