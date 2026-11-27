/** Start collecting optional host updates for one uninterrupted stretch of narration. */
export type TourBriefings = (signal: AbortSignal) => () => string | undefined;

// Realtime can finish generating a response well before its audio finishes playing.
export class RealtimeTour {
  #active = false;
  #responding = false;
  #playing = false;
  #visitorSpeaking = false;
  #waitingForTools = false;
  #timer?: ReturnType<typeof setTimeout>;
  #period?: AbortController;
  #readBriefing?: () => string | undefined;
  readonly #next: (briefing?: string) => void;
  readonly #briefings?: TourBriefings;
  constructor(next: (briefing?: string) => void, briefings?: TourBriefings) {
    this.#next = next;
    this.#briefings = briefings;
  }

  setActive(active: boolean) {
    if (active === this.#active) return;
    this.#active = active;
    if (active && this.#briefings) {
      this.#period = new AbortController();
      try { this.#readBriefing = this.#briefings(this.#period.signal); }
      catch { /* The tour can proceed without host updates. */ }
    } else if (!active) {
      clearTimeout(this.#timer);
      this.#period?.abort();
      this.#period = undefined;
      this.#readBriefing = undefined;
    }
  }

  observe(event: {type: string; response?: {output?: {type: string}[]}}) {
    switch (event.type) {
      case "response.created":
        this.#responding = true;
        this.#waitingForTools = false;
        break;
      case "response.done":
        this.#responding = false;
        this.#waitingForTools = !!event.response?.output?.some(item => item.type === "function_call");
        break;
      case "output_audio_buffer.started": this.#playing = true; break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": this.#playing = false; break;
      case "input_audio_buffer.speech_started": this.#visitorSpeaking = true; break;
      case "input_audio_buffer.speech_stopped":
        this.#visitorSpeaking = false;
        // The provider's VAD creates the visitor's response.
        this.#responding = true;
        break;
      default: return;
    }
    clearTimeout(this.#timer);
    if (this.#active && !this.#responding && !this.#playing && !this.#visitorSpeaking && !this.#waitingForTools) {
      this.#timer = setTimeout(() => {
        let briefing: string | undefined;
        try { briefing = this.#readBriefing?.()?.trim().slice(0, 384); }
        catch { /* A failed update must not interrupt narration. */ }
        this.#next(briefing || undefined);
      }, 4200);
    }
  }
}
