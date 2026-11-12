/** Tiny shared WebAudio engine: one square-wave voice per buzzer. */
class Audio {
  ctx: AudioContext | null = null;
  muted = false;
  private voices = new Set<{ osc: OscillatorNode | null; gain: GainNode | null }>();

  /** Must be called from a user gesture before sound can play. */
  unlock() {
    try {
      if (typeof window === 'undefined') return;
      this.ctx = this.ctx || new (window.AudioContext || (window as any).webkitAudioContext)();
      this.ctx!.resume();
    } catch { /* audio unavailable */ }
  }

  voice() {
    const v = { osc: null as OscillatorNode | null, gain: null as GainNode | null };
    this.voices.add(v);
    const self = this;
    return {
      set(freq: number) {
        const c = self.ctx;
        if (!c || self.muted || freq <= 0) { if (v.osc) { try { v.osc.stop(); } catch { } v.osc = null; } return; }
        if (!v.osc) {
          v.osc = c.createOscillator(); v.gain = c.createGain();
          v.osc.type = 'square'; v.gain.gain.value = 0.02;
          v.osc.connect(v.gain).connect(c.destination); v.osc.start();
        }
        v.osc.frequency.setTargetAtTime(freq, c.currentTime, 0.005);
      },
    };
  }

  silenceAll() { this.voices.forEach(v => { if (v.osc) { try { v.osc.stop(); } catch { } v.osc = null; } }); }
}
export const audio = new Audio();
