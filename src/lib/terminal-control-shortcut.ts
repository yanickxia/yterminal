type ControlKeyEvent = Pick<KeyboardEvent,
  "type" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" |
  "isComposing" | "keyCode" | "repeat" | "preventDefault"
>;

export function createControlEnterHandler(options: {
  enabled: () => boolean;
  readOnly: () => boolean;
  takeControl: () => Promise<void>;
  onError: (error: unknown) => void;
}): (event: ControlKeyEvent) => boolean {
  let pending = false;
  let consumedPress = false;

  return (event) => {
    if (event.key !== "Enter") return false;
    if (event.type === "keyup") {
      consumedPress = false;
      return false;
    }
    if (event.type === "keydown" && !event.repeat) consumedPress = false;
    // Keep the initiating press out of the PTY even if control arrives before
    // keypress or a held key repeats. A fresh press can submit normally.
    if (consumedPress) {
      event.preventDefault();
      return true;
    }
    if (
      event.type !== "keydown" || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
      !options.enabled() || !options.readOnly()
    ) return false;

    event.preventDefault();
    consumedPress = true;
    if (!pending && !event.repeat) {
      pending = true;
      void (async () => {
        try {
          await options.takeControl();
        } catch (error) {
          options.onError(error);
        } finally {
          pending = false;
        }
      })();
    }
    return true;
  };
}
