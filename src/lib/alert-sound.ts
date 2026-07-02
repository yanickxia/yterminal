// alert-sound: a short, synthesized attention chime played through WebAudio.
//
// We synthesize the tone rather than bundle an audio asset so there's nothing
// to ship, decode, or fail to load. The sound is intentionally soft and brief —
// two quick descending sine blips — so a pane asking for attention is noticed
// without being jarring when several fire in a burst.
//
// Callers gate on the user setting themselves (see terminal-manager); this
// module only adds a short throttle so a chatty bell (a TUI redraw that emits
// several BELs) doesn't machine-gun the speaker.

let ctx: AudioContext | null = null;
let lastPlayed = 0;
/** Minimum gap between chimes, ms. Bursts within this window collapse to one. */
const THROTTLE_MS = 1500;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/**
 * Play the attention chime, honoring the throttle. Best-effort: any failure
 * (no WebAudio, suspended context that won't resume) is swallowed — a missing
 * sound must never break terminal flow. `force` bypasses the throttle for an
 * explicit user test (Settings "preview" button).
 */
export function playAlertSound(force = false): void {
  const now = Date.now();
  if (!force && now - lastPlayed < THROTTLE_MS) return;

  const ac = audioContext();
  if (!ac) return;
  // Autoplay policy can leave the context suspended until a user gesture; a
  // bell arriving after the user has interacted with the page resumes fine.
  if (ac.state === "suspended") void ac.resume().catch(() => {});

  lastPlayed = now;
  try {
    const t0 = ac.currentTime;
    const gain = ac.createGain();
    gain.connect(ac.destination);
    // two short blips: 880Hz then 660Hz, each ~120ms with a soft envelope.
    const blips: Array<[number, number]> = [
      [880, t0],
      [660, t0 + 0.14],
    ];
    for (const [freq, start] of blips) {
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(g);
      g.connect(gain);
      osc.start(start);
      osc.stop(start + 0.13);
    }
  } catch {
    /* WebAudio scheduling failed — ignore */
  }
}

/** Test seam: reset the throttle so tests don't depend on wall-clock timing. */
export function __resetAlertThrottleForTests(): void {
  lastPlayed = 0;
}
