import { CONTROL_GROUPS, CONTROL_SEPARATORS } from "./controls";
import { Dialog } from "./Dialog";

/** Reference of every control and shortcut. Opened from the main menu. */
export function ControlsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Controls" onClose={onClose}>
      {CONTROL_GROUPS.map((group) => (
        <section key={group.title}>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">{group.title}</h3>
          <dl className="flex flex-col gap-1.5">
            {group.rows.map((row) => (
              <div key={row.action} className="flex items-baseline justify-between gap-4">
                <dt className="text-neutral-300">{row.action}</dt>
                <dd className="flex shrink-0 items-center gap-1">
                  {row.keys.map((key, i) =>
                    CONTROL_SEPARATORS.has(key) ? (
                      <span key={i} className="px-0.5 text-xs text-neutral-500">
                        {key}
                      </span>
                    ) : (
                      <kbd
                        key={i}
                        className="min-w-6 rounded-md border border-white/15 border-b-white/25 bg-white/5 px-1.5 py-0.5 text-center font-sans text-xs text-neutral-200"
                      >
                        {key}
                      </kbd>
                    ),
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
