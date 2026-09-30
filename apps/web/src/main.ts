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
terminal.onInterrupt = () => wallet.lock();

const status: Status = {
    setSession: state => {
        element('session-state').textContent = { locked: 'LOCKED', setup: 'NEW WALLET', unlocked: 'UNLOCKED' }[state];
        element('session-state').classList.toggle('unlocked', state === 'unlocked');
    },
    setNetwork: name => { element('network').textContent = name ?? ''; }
};

const dials: Array<[string, () => void]> = [
    ['preset', () => display.cyclePreset()],
    ['scanlines', () => display.toggle('scanlines')],
    ['curvature', () => display.toggle('curvature')],
    ['sweep', () => display.cycleSweep()],
    ['sound', () => display.toggle('sound')]
];
for (const [id, act] of dials) {
    element(id).addEventListener('click', () => { act(); terminal.focus(); });
}

runHost(terminal, wallet, display, status).catch(error => {
    console.error(error);
    terminal.print('The terminal stopped unexpectedly. Reload the page.');
});
