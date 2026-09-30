/** Optional keyboard feedback, synthesized so no audio files are needed. Silent while disabled. */
export class Sound {
    enabled = false;
    private context?: AudioContext;
    private noiseBuffer?: AudioBuffer;

    private play(render: (context: AudioContext, at: number) => void): void {
        if (!this.enabled) return;
        try {
            this.context ??= new AudioContext();
            const context = this.context;
            if (context.state === 'suspended') void context.resume();
            render(context, context.currentTime);
        } catch {
            // Sound is a courtesy; a browser that refuses it changes nothing else.
        }
    }

    private envelope(context: AudioContext, at: number, milliseconds: number, volume: number): GainNode {
        const gain = context.createGain();
        gain.gain.setValueAtTime(volume, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + milliseconds / 1000);
        gain.connect(context.destination);
        return gain;
    }

    private tone(context: AudioContext, at: number, frequency: number, milliseconds: number, type: OscillatorType, volume: number): void {
        const oscillator = context.createOscillator();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        oscillator.connect(this.envelope(context, at, milliseconds, volume));
        oscillator.start(at);
        oscillator.stop(at + milliseconds / 1000);
    }

    /** A short slice of filtered white noise: the percussive part of a key switch. */
    private noise(context: AudioContext, at: number, filter: BiquadFilterType, frequency: number, q: number, milliseconds: number, volume: number): void {
        this.noiseBuffer ??= (() => {
            const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.25), context.sampleRate);
            const samples = buffer.getChannelData(0);
            for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
            return buffer;
        })();
        const source = context.createBufferSource();
        const shape = context.createBiquadFilter();
        source.buffer = this.noiseBuffer;
        shape.type = filter;
        shape.frequency.value = frequency;
        shape.Q.value = q;
        source.connect(shape).connect(this.envelope(context, at, milliseconds, volume));
        source.start(at, Math.random() * 0.15);
        source.stop(at + milliseconds / 1000);
    }

    /** Switch click, keycap resonance and the bottom-out thock; every press varies a little like a real board. */
    private press(context: AudioContext, at: number, depth: number, volume: number): void {
        const vary = 0.9 + Math.random() * 0.2;
        const loud = volume * (0.85 + Math.random() * 0.3);
        this.noise(context, at, 'highpass', 2200 * vary, 0.7, 9, loud * 0.5);
        this.noise(context, at + 0.003, 'bandpass', 950 * vary / depth, 3, 22, loud * 0.9);
        this.noise(context, at + 0.004, 'lowpass', 230 * vary / depth, 1.5, 55 * depth, loud * 1.4);
    }

    key(): void { this.play((context, at) => this.press(context, at, 1, 0.16)); }
    move(): void { this.play((context, at) => this.tone(context, at, 900, 10, 'square', 0.015)); }
    /** A stabilized key: deeper, with the stabilizer wire landing just after the stem. */
    enter(): void {
        this.play((context, at) => {
            this.press(context, at, 1.6, 0.2);
            this.noise(context, at + 0.014, 'bandpass', 1600, 4, 12, 0.035);
        });
    }
    error(): void { this.play((context, at) => this.tone(context, at, 120, 140, 'sawtooth', 0.05)); }
}
