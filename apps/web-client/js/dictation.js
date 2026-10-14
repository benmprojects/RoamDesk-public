// Dictation: the mic button types what you say into the message box, using the browser's own speech recognition
// (Chrome, Edge and Safari have it; Firefox doesn't, so the button stays hidden there). Nothing is sent until you
// press Enter. Chrome and Edge send the audio to their own speech service to turn it into text.

/** What the box should hold: the text that was there when dictation started, then what's been heard so far. */
export function mergeTranscript(base, heard) {
  const said = (Array.isArray(heard) ? heard : []).map((r) => String(r?.transcript ?? "")).join("").trim();
  const before = String(base ?? "");
  if (!said) return before;
  return before + (before && !/\s$/.test(before) ? " " : "") + said;
}

/** A plain-English reason for a speech error code, or "" when it needn't be shown. */
export function micError(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "The microphone is blocked. Allow it for this site from the padlock in the address bar, then try again.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs an internet connection.";
    case "no-speech":
    case "aborted":
      return "";
    default:
      return `Speech recognition stopped (${code}).`;
  }
}

export class Dictation {
  /** @param {{ button: HTMLElement, input: HTMLTextAreaElement, toast: (t: string) => void }} o */
  constructor({ button, input, toast }) {
    this.button = button;
    this.input = input;
    this.toast = toast;
    this.rec = null;
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    this.SR = SR ?? null;
    button.hidden = !SR;
    button.addEventListener("click", () => (this.rec ? this.stop() : this.start()));
  }

  get active() {
    return Boolean(this.rec);
  }

  start() {
    if (!this.SR || this.rec) return;
    const base = this.input.value;
    const rec = new this.SR();
    rec.lang = "en-AU";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      const heard = [];
      for (let i = 0; i < ev.results.length; i++) heard.push({ transcript: ev.results[i][0].transcript });
      this.input.value = mergeTranscript(base, heard);
      this.input.dispatchEvent(new Event("input")); // so the box grows with the text
    };
    rec.onerror = (ev) => {
      const msg = micError(ev.error);
      if (msg) this.toast(msg);
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      this.show();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
    }
    this.show();
  }

  stop() {
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.stop();
    } catch {
      /* already stopped */
    }
    this.show();
  }

  show() {
    const on = this.active;
    this.button.classList.toggle("listening", on);
    this.button.setAttribute("aria-pressed", String(on));
    this.button.title = on ? "Stop dictating" : "Dictate with your voice (nothing is sent until you press Enter)";
  }
}
