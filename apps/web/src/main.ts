import './style.css';
import { runHost, type Status } from './host.js';
import { Display } from './terminal/display.js';
import { Sound } from './terminal/sound.js';
import { DomTerminal } from './terminal/terminal.js';
import { BrowserWallet } from './wallet.js';

const element = (id: string): HTMLElement => document.getElementById(id)!;

const sound = new Sound();
const display = new Display(document.documentElement, sound);
const terminal = new DomTerminal(element('out'), sound);
const wallet = new BrowserWallet(() => terminal.abort());

const status: Status = {
    setSession: state => {
        element('session-state').textContent = { locked: 'LOCKED', setup: 'NEW WALLET', unlocked: 'UNLOCKED' }[state];
        element('session-state').classList.toggle('unlocked', state === 'unlocked');
    },
    setNetwork: name => { element('network').textContent = name ?? ''; }
};

const dials: Array<[string, () => void]> = [
    ['text-smaller', () => display.stepText(-1)],
    ['text-larger', () => display.stepText(1)],
    ['preset', () => display.cyclePreset()],
    ['scanlines', () => display.toggle('scanlines')],
    ['curvature', () => display.toggle('curvature')],
    ['sweep', () => display.cycleSweep()],
    ['sound', () => display.toggle('sound')]
];
// The keys leave focus where it was: pressing one neither takes it from the prompt nor opens a phone's keyboard.
for (const [id, act] of dials) {
    element(id).addEventListener('mousedown', event => event.preventDefault());
    element(id).addEventListener('click', act);
}

runHost(terminal, wallet, status).catch(error => {
    console.error(error);
    terminal.print('The terminal stopped unexpectedly. Reload the page.');
});
