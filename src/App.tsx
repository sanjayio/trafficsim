import { useCallback, useState } from "react";
import { loadAutosave } from "./platform";
import type { Engine } from "./render/Engine";
import { ControlsDialog } from "./ui/ControlsDialog";
import { CursorHint } from "./ui/CursorHint";
import { GameCanvas } from "./ui/GameCanvas";
import { JunctionOverlay, LaneEditBar } from "./ui/JunctionOverlay";
import { MainMenu } from "./ui/MainMenu";
import { NewMapDialog } from "./ui/NewMapDialog";
import { Logo } from "./ui/Logo";
import { Radio } from "./ui/Radio";
import { SettingsDialog } from "./ui/SettingsDialog";
import { TutorialDialog } from "./ui/TutorialDialog";
import { StatusBar } from "./ui/StatusBar";
import { Toolbar } from "./ui/Toolbar";

export default function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [dialog, setDialog] = useState<"newMap" | "settings" | "controls" | "tutorial" | null>(
    // First visit (nothing kept in this browser): start by naming a map.
    () => (loadAutosave() ? null : "newMap"),
  );
  const closeDialog = useCallback(() => setDialog(null), []);

  return (
    <div className="relative h-full w-full text-sm text-neutral-100">
      <GameCanvas onEngine={setEngine} />
      <CursorHint />
      <JunctionOverlay engine={engine} />
      <LaneEditBar engine={engine} />
      <Radio />
      <Logo />
      <Toolbar />
      <MainMenu
        engine={engine}
        onNewMap={() => setDialog("newMap")}
        onShowSettings={() => setDialog("settings")}
        onShowControls={() => setDialog("controls")}
        onShowTutorial={() => setDialog("tutorial")}
      />
      <StatusBar engine={engine} />
      {dialog === "newMap" && engine && (
        <NewMapDialog engine={engine} onClose={closeDialog} onShowTutorial={() => setDialog("tutorial")} />
      )}
      {dialog === "tutorial" && <TutorialDialog onClose={closeDialog} />}
      {dialog === "settings" && <SettingsDialog engine={engine} onClose={closeDialog} />}
      {dialog === "controls" && <ControlsDialog onClose={closeDialog} />}
    </div>
  );
}
