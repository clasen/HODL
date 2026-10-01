import { webConfig } from '../../config.mjs';
import type { Sound } from './sound.js';

export type Preset = 'p1' | 'p3' | 'ice';
/** The bright band that rolls down the glass: at full strength, barely there, or gone. */
export type Sweep = 'full' | 'soft' | 'off';
export type Toggle = 'scanlines' | 'curvature' | 'sound';
export interface DisplayState { preset: Preset; sweep: Sweep; textScale: number; scanlines: boolean; curvature: boolean; sound: boolean }

const config = webConfig.terminal;
const presetLabels: Record<Preset, string> = { p1: 'GRN', p3: 'AMB', ice: 'ICE' };
const sweepNames: Record<Sweep, string> = { full: 'full', soft: 'subtle', off: 'off' };
const textSizeName = (scale: number): string => `${Math.round(scale * 100)}%`;

function isState(value: unknown): value is DisplayState {
    if (typeof value !== 'object' || value === null) return false;
    const state = value as Record<string, unknown>;
    return config.presets.includes(state.preset as string) && config.sweeps.includes(state.sweep as string) &&
        config.textScales.includes(state.textScale as number) &&
        typeof state.scanlines === 'boolean' && typeof state.curvature === 'boolean' && typeof state.sound === 'boolean';
}

/** The monitor's look: phosphor, glass effects and sound. Kept per browser, never inside the vault. */
export class Display {
    private current: DisplayState;

    constructor(private readonly root: HTMLElement, private readonly sound: Sound) {
        this.current = this.stored() ?? { ...config.defaults } as DisplayState;
        this.apply();
    }

    get state(): Readonly<DisplayState> { return this.current; }

    private stored(): DisplayState | undefined {
        try {
            const raw = localStorage.getItem(config.displayStorageKey);
            const value: unknown = raw ? JSON.parse(raw) : undefined;
            if (typeof value !== 'object' || value === null) return undefined;
            // Choices saved before a setting existed keep their values; the new setting takes its default.
            const merged = { ...config.defaults, ...value };
            return isState(merged) ? merged : undefined;
        } catch {
            return undefined;
        }
    }

    private apply(): void {
        const { preset, sweep, textScale, scanlines, curvature, sound } = this.current;
        this.root.dataset.preset = preset;
        this.root.dataset.sweep = sweep;
        this.root.style.setProperty('--text-scale', String(textScale));
        this.root.dataset.scanlines = scanlines ? 'on' : 'off';
        this.root.dataset.curvature = curvature ? 'on' : 'off';
        this.root.dataset.sound = sound ? 'on' : 'off';
        this.sound.enabled = sound;
        const set = (id: string, text: string, pressed: boolean | undefined): void => {
            const button = document.getElementById(id);
            if (!button) return;
            button.textContent = text;
            if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
        };
        set('preset', presetLabels[preset], undefined);
        set('scanlines', 'FX', scanlines);
        set('curvature', 'CRT', curvature);
        set('sound', 'SND', sound);
        // The sweep has three strengths, so its key glows fully, faintly or not at all instead of being pressed.
        const sweepKey = document.getElementById('sweep');
        if (sweepKey) {
            sweepKey.dataset.level = sweep;
            sweepKey.setAttribute('aria-label', `Rolling sweep bar: ${sweepNames[sweep]}`);
        }
        const scales = config.textScales;
        for (const [id, limit, action] of [['text-smaller', scales[0], 'Smaller'], ['text-larger', scales[scales.length - 1], 'Larger']] as const) {
            const button = document.getElementById(id) as HTMLButtonElement | null;
            if (!button) continue;
            button.disabled = textScale === limit;
            button.title = `${action} text (now ${textSizeName(textScale)})`;
        }
    }

    private update(next: DisplayState): void {
        this.current = next;
        this.apply();
        try {
            localStorage.setItem(config.displayStorageKey, JSON.stringify(next));
        } catch {
            // Without storage the choice lasts for this visit.
        }
    }

    setPreset(preset: Preset): void { this.update({ ...this.current, preset }); }

    cyclePreset(): void {
        const presets = config.presets as Preset[];
        this.setPreset(presets[(presets.indexOf(this.current.preset) + 1) % presets.length]);
    }

    setSweep(sweep: Sweep): void { this.update({ ...this.current, sweep }); }

    cycleSweep(): void {
        const sweeps = config.sweeps as Sweep[];
        this.setSweep(sweeps[(sweeps.indexOf(this.current.sweep) + 1) % sweeps.length]);
    }

    setTextScale(textScale: number): void {
        if (!config.textScales.includes(textScale)) throw new Error(`Unknown text scale: ${textScale}`);
        this.update({ ...this.current, textScale });
    }

    /** Moves one step along the configured text sizes, stopping at either end. */
    stepText(direction: 1 | -1): void {
        const scales = config.textScales;
        const index = scales.indexOf(this.current.textScale) + direction;
        if (index >= 0 && index < scales.length) this.setTextScale(scales[index]);
    }

    toggle(name: Toggle): void { this.update({ ...this.current, [name]: !this.current[name] }); }
}
