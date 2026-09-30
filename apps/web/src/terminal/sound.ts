/** Optional keyboard feedback, synthesized so no audio files are needed. Silent until enabled. */
export class Sound {
    enabled = false;
    private context?: AudioContext;

    private tone(frequency: number, milliseconds: number, type: OscillatorType, volume: number): void {
        if (!this.enabled) return;
        try {
            this.context ??= new AudioContext();
            const context = this.context;
            if (context.state === 'suspended') void context.resume();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const end = context.currentTime + milliseconds / 1000;
            oscillator.type = type;
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(volume, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, end);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(end);
        } catch {
            // Sound is a courtesy; a browser that refuses it changes nothing else.
        }
    }

    key(): void { this.tone(1400, 14, 'square', 0.02); }
    move(): void { this.tone(900, 10, 'square', 0.015); }
    enter(): void { this.tone(520, 45, 'triangle', 0.04); }
    error(): void { this.tone(120, 140, 'sawtooth', 0.05); }
}
