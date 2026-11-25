import { useCallback, useState } from "react";
import type { Engine } from "./render/Engine";
import { ControlsDialog } from "./ui/ControlsDialog";
import { CursorHint } from "./ui/CursorHint";
import { GameCanvas } from "./ui/GameCanvas";
import { JunctionOverlay, LaneEditBar } from "./ui/JunctionOverlay";
import { MainMenu } from "./ui/MainMenu";
import { Radio } from "./ui/Radio";
import { SettingsDialog } from "./ui/SettingsDialog";
import { StatusBar } from "./ui/StatusBar";
import { Toolbar } from "./ui/Toolbar";

export default function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [dialog, setDialog] = useState<"settings" | "controls" | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  return (
    <div className="relative h-full w-full text-sm text-neutral-100">
      <GameCanvas onEngine={setEngine} />
      <CursorHint />
      <JunctionOverlay engine={engine} />
      <LaneEditBar engine={engine} />
      <Radio />
      <Toolbar />
      <MainMenu
        engine={engine}
        onShowSettings={() => setDialog("settings")}
        onShowControls={() => setDialog("controls")}
      />
      <StatusBar />
      {dialog === "settings" && <SettingsDialog onClose={closeDialog} />}
      {dialog === "controls" && <ControlsDialog onClose={closeDialog} />}
    </div>
  );
}
