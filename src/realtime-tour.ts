// Realtime can finish generating a response well before its audio finishes playing.
export class RealtimeTour {
  #active = true;
  #responding = false;
  #playing = false;
  #visitorSpeaking = false;
  #waitingForTools = false;
  #timer?: ReturnType<typeof setTimeout>;
  readonly #next: () => void;
  constructor(next: () => void) { this.#next = next; }

  setActive(active: boolean) {
    this.#active = active;
    if (!active) clearTimeout(this.#timer);
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
      this.#timer = setTimeout(this.#next, 4200);
    }
  }
}
