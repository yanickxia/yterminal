// Schedule a single update check ~5s after launch. Failures are swallowed
// (logged); the user is not notified at launch — Settings shows the error
// for users who care.
import { useUpdaterStore } from "../stores/updater-store";

export function scheduleAutoCheck(): void {
  setTimeout(() => {
    useUpdaterStore
      .getState()
      .check()
      .catch((e) => console.warn("[updater] auto-check failed:", e));
  }, 5000);
}
