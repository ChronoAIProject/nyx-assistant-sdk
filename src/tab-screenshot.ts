// The browser's Capture Handle identifies this document even among same-origin tabs.
type TabTrack = MediaStreamTrack & {getCaptureHandle?(): {handle: string} | null};
type Devices = MediaDevices & {setCaptureHandleConfig?(config: {handle: string; permittedOrigins: string[]}): void};
export class TabScreenshot {
  #video = document.createElement("video");
  #track?: TabTrack;
  #handle = crypto.randomUUID();
  #changed: () => void;
  constructor(changed: () => void) { this.#changed = changed; }
  static supported() {
    const devices = navigator.mediaDevices as Devices | undefined;
    return window.top === window && !!devices?.getDisplayMedia && !!devices.setCaptureHandleConfig;
  }
  get active() { return this.#track?.readyState === "live"; }
  async share(signal: AbortSignal) {
    const devices = navigator.mediaDevices as Devices;
    devices.setCaptureHandleConfig!({handle: this.#handle, permittedOrigins: [location.origin]});
    const options = {audio: false, video: {displaySurface: "browser", frameRate: {ideal: 4, max: 6}},
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude", monitorTypeSurfaces: "exclude"};
    const stream = await devices.getDisplayMedia(options);
    const track = stream.getVideoTracks()[0] as TabTrack;
    try {
      signal.throwIfAborted();
      if (track?.getCaptureHandle?.()?.handle !== this.#handle) throw Error("Select this dashboard tab.");
      this.#track = track;
      track.onended = () => this.stop();
      this.#video.muted = true;
      this.#video.playsInline = true;
      this.#video.srcObject = stream;
      await this.#video.play();
      signal.throwIfAborted();
      this.#changed();
    } catch (error) { stream.getTracks().forEach(t => t.stop()); this.stop(); throw error; }
  }
  async frame(maxMessageSize: number) {
    const video = this.#video;
    if (!this.active || this.#track?.getCaptureHandle?.()?.handle !== this.#handle || video.readyState < 2) return;
    if (video.requestVideoFrameCallback) {
      await new Promise<void>(resolve => {
        const callback = video.requestVideoFrameCallback(() => { clearTimeout(limit); resolve(); });
        const limit = setTimeout(() => { video.cancelVideoFrameCallback(callback); resolve(); }, 650);
      });
    }
    if (!this.active || this.#track?.getCaptureHandle?.()?.handle !== this.#handle) return;
    const canvas = document.createElement("canvas");
    let scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    const ctx = canvas.getContext("2d");
    if (!ctx || !video.videoWidth || !video.videoHeight) return;
    while (scale * Math.max(video.videoWidth, video.videoHeight) >= 240) {
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL("image/jpeg", 0.72);
      if (image.startsWith("data:image/jpeg;base64,") && image.length + 600 < Math.min(maxMessageSize || 65536, 160000)) return image;
      scale *= 0.8;
    }
  }
  stop() {
    if (this.#track) { this.#track.onended = null; this.#track.stop(); }
    this.#track = undefined;
    this.#video.pause();
    this.#video.srcObject = null;
    this.#changed();
  }
}
