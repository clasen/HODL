import { PromptAborted, type Cell, type Choice, type Spinner, type TableSpec, type Ui, type Validation } from 'hodl-wallet/browser';
import { webConfig } from '../../config.mjs';
import type { Sound } from './sound.js';

const config = webConfig.terminal;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const passwordEcho = '********';

interface Active {
    onKey(event: KeyboardEvent): void;
    focus(): void;
    /** A menu answers touch: a swipe moves its highlight and a tap on the screen picks it. */
    swipe?(step: number): void;
    tap?(): void;
    /** Drops whatever the prompt holds, secrets included. */
    dispose(): void;
}

interface ChoiceView {
    move(step: number): void;
    jump(index: number): void;
    index(): number;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

/** Output text; a value that is a whole https URL, like an explorer link, becomes a link styled as the text around it. */
function write<T extends HTMLElement>(element: T, text: string): T {
    if (!/^https:\/\/\S+$/.test(text)) {
        element.textContent = text;
        return element;
    }
    const link = node('a', 'link', text);
    link.href = text;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    element.append(link);
    return element;
}

/**
 * An input that is a field of a prompt: no browser help that would store or alter what is typed.
 * Secrets are masked by style, not type=password, because password managers ignore data-bwignore there.
 */
function promptField(className: string, label: string, type = 'text'): HTMLInputElement {
    const input = node('input', className);
    input.type = type;
    input.autocomplete = 'off';
    input.autocapitalize = 'none';
    input.spellcheck = false;
    input.setAttribute('data-bwignore', '');
    input.setAttribute('aria-label', label);
    return input;
}

function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The shared wallet flows on a phosphor terminal: prompts are keyboard driven and real form controls,
 * output is a scrolling transcript. Locking rejects every pending and later prompt until reset().
 */
export class DomTerminal implements Ui {
    /** Set by the host: Ctrl+C with nothing selected means leave. */
    onInterrupt: () => void = () => {};
    private active?: Active;
    /** The block of the prompt that is waiting, where a swipe changes a menu's choice. */
    private activeBlock?: HTMLElement;
    private aborted = false;
    private prompts = 0;
    private choiceIds = 0;
    private readonly secrets = new Set<() => void>();
    private readonly spinners = new Set<() => void>();

    constructor(private readonly transcript: HTMLElement, private readonly sound: Sound) {
        const scroller = transcript.parentElement!;
        let pinned = true;
        scroller.addEventListener('scroll', () => { pinned = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4; });
        // A spinner frame changes no height, so it must not force a layout.
        new MutationObserver(records => {
            if (pinned && records.some(record => !(record.target as Element).classList?.contains('frame'))) scroller.scrollTop = scroller.scrollHeight;
        }).observe(transcript, { childList: true, subtree: true });
        // Focusing the prompt, or the screen shrinking under a keyboard, always brings the prompt back into view.
        transcript.addEventListener('focusin', () => requestAnimationFrame(() => this.reveal()));
        new ResizeObserver(() => {
            if (pinned) scroller.scrollTop = scroller.scrollHeight;
            this.reveal();
        }).observe(scroller);
        document.addEventListener('keydown', this.onKeyDown);
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.clearSecrets(); });
        // A click or tap anywhere on the screen, empty space included, returns to the prompt unless it selected text.
        const screen = transcript.closest<HTMLElement>('.crt') ?? scroller;
        screen.addEventListener('click', () => {
            if (!window.getSelection()?.toString()) this.active?.focus();
        });
        this.touchMenus(screen);
        window.addEventListener('focus', () => this.active?.focus());
    }

    /** Scrolls the focused prompt, or a menu's highlighted choice, into view. */
    private reveal(): void {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement) || !this.transcript.contains(focused)) return;
        (focused.querySelector<HTMLElement>('li.sel') ?? focused).scrollIntoView({ block: 'nearest' });
    }

    /**
     * While a menu waits, a vertical swipe that starts on the menu (or below it) moves its highlight, following the
     * finger; one that starts on the text above scrolls the transcript. A tap anywhere on the screen answers the menu
     * like Enter; touching a choice does not pick it, and a mouse still clicks choices. Other prompts scroll and
     * focus as usual.
     */
    private touchMenus(screen: HTMLElement): void {
        let gesture: { x: number; y: number; anchor: number; moved: boolean; menu: boolean; onMenu: boolean } | undefined;
        screen.addEventListener('touchstart', event => {
            const touch = event.touches[0];
            const menu = Boolean(this.active?.swipe);
            const onMenu = menu && touch.clientY >= (this.activeBlock?.getBoundingClientRect().top ?? Infinity);
            gesture = event.touches.length === 1
                ? { x: touch.clientX, y: touch.clientY, anchor: touch.clientY, moved: false, menu, onMenu }
                : undefined;
        }, { passive: true });
        screen.addEventListener('touchmove', event => {
            if (!gesture) return;
            const touch = event.touches[0];
            if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) > config.tapSlopPx) gesture.moved = true;
            if (!gesture.onMenu || !this.active?.swipe) return;
            event.preventDefault();
            const steps = Math.trunc((touch.clientY - gesture.anchor) / config.swipeStepPx);
            if (steps === 0) return;
            gesture.anchor += steps * config.swipeStepPx;
            this.active.swipe(steps);
        }, { passive: false });
        screen.addEventListener('touchend', event => {
            const ended = gesture;
            gesture = undefined;
            if (!ended?.menu || !this.active?.tap) return;
            // No click follows, so the touched choice is never picked in place of the highlighted one.
            event.preventDefault();
            if (!ended.moved) this.active.tap();
        });
        screen.addEventListener('touchcancel', () => { gesture = undefined; });
    }

    // ---- lifecycle

    /** Rejects the pending prompt and refuses new ones. Used when the wallet locks. */
    abort(): void {
        this.aborted = true;
        this.clearSecrets();
        this.spinners.forEach(stop => stop());
        this.active?.dispose();
    }

    reset(): void { this.aborted = false; }

    /** True from a lock until the host resets: no prompt can be answered. */
    get isAborted(): boolean { return this.aborted; }

    /** Prompts the person has answered so far. */
    get answered(): number { return this.prompts; }

    clear(): void {
        this.clearSecrets();
        this.transcript.replaceChildren();
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        const target = event.target as Element | null;
        if (target?.closest('.strip') || event.isComposing || event.keyCode === 229) return;
        // Keys typed after a click elsewhere on the page still belong to the prompt.
        if (this.active && event.key !== 'Tab' && !(target instanceof HTMLInputElement) && !target?.closest('.choices')) this.active.focus();
        const modifier = event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta';
        if (!modifier && !event.repeat && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')) this.clearSecrets();
        if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c') {
            const field = document.activeElement;
            const selected = field instanceof HTMLInputElement ? field.selectionStart !== field.selectionEnd : Boolean(window.getSelection()?.toString());
            if (!selected) {
                event.preventDefault();
                this.onInterrupt();
                return;
            }
        }
        if (!modifier) this.sound.key();
        this.active?.onKey(event);
    };

    // ---- output

    private append<T extends HTMLElement>(element: T): T {
        this.transcript.append(element);
        while (this.transcript.childElementCount > config.scrollbackMax) {
            const first = this.transcript.firstElementChild!;
            if (first.classList.contains('secret') || first.classList.contains('prompt') && !first.classList.contains('done')) break;
            first.remove();
        }
        return element;
    }

    banner(art: string): void {
        this.append(node('pre', 'logo', art));
    }

    print(text: string): void {
        this.append(write(node('div', 'l'), text));
    }

    table(spec: TableSpec): void {
        const cell = (tag: 'th' | 'td', value: Cell): HTMLElement => {
            const element = node(tag);
            if (typeof value !== 'string') element.colSpan = value.colSpan;
            return write(element, typeof value === 'string' ? value : value.content);
        };
        const wrap = node('div', 'tbl-wrap');
        wrap.dataset.tone = spec.tone;
        const table = node('table', 'tbl');
        const head = node('tr');
        spec.head.forEach(value => head.append(cell('th', value)));
        const header = node('thead');
        header.append(head);
        table.append(header);
        const body = node('tbody');
        for (const row of spec.rows ?? []) {
            const line = node('tr');
            row.forEach(value => line.append(cell('td', value)));
            body.append(line);
        }
        table.append(body);
        wrap.append(table);
        if (spec.tone === 'red') {
            wrap.setAttribute('role', 'alert');
            this.sound.error();
        }
        if (spec.secret) this.secret(wrap);
        else this.append(wrap);
    }

    private secret(table: HTMLElement): void {
        const block = node('div', 'secret');
        const note = node('div', 'l dim');
        const deadline = Date.now() + config.secretMs;
        const describe = (): void => {
            note.textContent = `SENSITIVE · clears in ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s or on the next key press`;
        };
        describe();
        block.append(note, table);
        // The countdown is only display; the hard stop must not depend on a throttled interval.
        const ticker = setInterval(describe, 1000);
        const stop = setTimeout(() => clear(), config.secretMs);
        const clear = (): void => {
            clearInterval(ticker);
            clearTimeout(stop);
            this.secrets.delete(clear);
            block.replaceChildren(node('div', 'l dim', '[sensitive output cleared]'));
            block.classList.remove('secret');
        };
        this.secrets.add(clear);
        this.append(block);
    }

    private clearSecrets(): void {
        [...this.secrets].forEach(clear => clear());
    }

    spinner(text: string): Spinner {
        const line = this.append(node('div', 'l spin'));
        const label = node('span', undefined, text);
        const frame = node('span', 'frame', reducedMotion() ? '…' : spinnerFrames[0]);
        line.append(frame, ' ', label);
        let index = 0;
        const timer = reducedMotion() ? undefined : setInterval(() => { frame.textContent = spinnerFrames[++index % spinnerFrames.length]; }, config.spinnerMs);
        const halt = (): void => { clearInterval(timer); this.spinners.delete(halt); };
        this.spinners.add(halt);
        const settle = (symbol: string, message: string, className: string): void => {
            halt();
            line.className = `l ${className}`;
            if (className === 'fail') { line.setAttribute('role', 'alert'); this.sound.error(); }
            line.replaceChildren(`${symbol} ${message}`);
        };
        return {
            succeed: message => settle('✔', message, 'ok'),
            fail: message => settle('✖', message, 'fail'),
            stop: () => { halt(); line.remove(); }
        };
    }

    // ---- prompts

    private ask<T>(kind: string, message: string, build: (finish: (value: T, echo: string) => void, body: HTMLElement) => Active): Promise<T> {
        if (this.aborted) return Promise.reject(new PromptAborted());
        return new Promise<T>((resolve, reject) => {
            const block = this.append(node('div', 'prompt'));
            block.dataset.prompt = kind;
            const settle = (echo: string, symbol: string): void => {
                this.active = undefined;
                this.activeBlock = undefined;
                block.classList.add('done');
                block.replaceChildren(node('div', 'l answered', `${symbol} ${message} ${echo}`.trimEnd()));
            };
            const active = build((value, echo) => { settle(echo, '✔'); this.prompts++; this.sound.enter(); resolve(value); }, block);
            this.activeBlock = block;
            this.active = {
                ...active,
                dispose: () => {
                    active.dispose();
                    settle('^C', '✖');
                    reject(new PromptAborted());
                }
            };
            this.active.focus();
        });
    }

    private heading(message: string, hint: string): HTMLElement {
        const line = node('div', 'l q');
        line.append(node('span', 'mark', '? '), node('span', 'message', message));
        if (hint) line.append(' ', node('span', 'hint', hint));
        return line;
    }

    private wire<T>(items: Array<Choice<T>>, list: HTMLElement, start: number, pick: (index: number) => void): ChoiceView {
        let index = start;
        const prefix = `c${++this.choiceIds}-`;
        const rows = items.map((item, position) => {
            const row = node('li', 'choice');
            row.id = `${prefix}${position}`;
            row.setAttribute('role', 'option');
            row.append(node('span', 'ptr', '  '), item.name);
            row.addEventListener('click', () => pick(position));
            list.append(row);
            return row;
        });
        const paint = (): void => {
            rows.forEach((row, position) => {
                row.classList.toggle('sel', position === index);
                row.setAttribute('aria-selected', String(position === index));
                row.firstElementChild!.textContent = position === index ? '❯ ' : '  ';
            });
            if (rows[index]) {
                list.setAttribute('aria-activedescendant', rows[index].id);
                rows[index].scrollIntoView?.({ block: 'nearest' });
            }
        };
        paint();
        return {
            move: step => { if (!rows.length) return; index = ((index + step) % rows.length + rows.length) % rows.length; this.sound.move(); paint(); },
            jump: position => { if (position >= 0 && position < rows.length) { index = position; this.sound.move(); paint(); } },
            index: () => index
        };
    }

    select<T>(question: { message: string; choices: Array<Choice<T>>; default?: T }): Promise<T> {
        const { message, choices } = question;
        return this.ask<T>('select', message, (finish, block) => {
            block.append(this.heading(message, '(Use arrow keys)'));
            const list = node('ul', 'choices');
            list.setAttribute('role', 'listbox');
            list.setAttribute('aria-label', message);
            list.tabIndex = 0;
            block.append(list);
            const chosen = (position: number): void => finish(choices[position].value, choices[position].name);
            const start = Math.max(0, choices.findIndex(choice => choice.value === question.default));
            const view = this.wire(choices, list, start, chosen);
            return {
                focus: () => list.focus({ preventScroll: true }),
                dispose: () => list.remove(),
                swipe: step => view.move(step),
                tap: () => chosen(view.index()),
                onKey: event => {
                    if (event.ctrlKey || event.metaKey || event.altKey) return;
                    if (event.key === 'ArrowDown' || event.key === 'j') view.move(1);
                    else if (event.key === 'ArrowUp' || event.key === 'k') view.move(-1);
                    else if (event.key === 'Home') view.jump(0);
                    else if (event.key === 'End') view.jump(choices.length - 1);
                    else if (/^[1-9]$/.test(event.key)) view.jump(Number(event.key) - 1);
                    else if (event.key === 'Enter' && !event.repeat) chosen(view.index());
                    else if (event.key === 'Escape') {
                        const back = choices.findIndex(choice => choice.back);
                        if (back < 0) return;
                        chosen(back);
                    } else return;
                    event.preventDefault();
                }
            };
        });
    }

    private textPrompt(kind: 'input' | 'password', question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string> {
        const { message, validate } = question;
        return this.ask<string>(kind, message, (finish, block) => {
            const row = this.heading(message, '');
            row.classList.add('field');
            const field = promptField(kind === 'password' ? 'field-input masked' : 'field-input', message);
            if (kind === 'password') for (const leak of ['copy', 'cut'] as const) field.addEventListener(leak, event => event.preventDefault());
            field.value = question.default ?? '';
            row.append(' ', field);
            const problem = node('div', 'l err');
            block.append(row, problem);
            const submit = (): void => {
                const value = field.value;
                const check = validate?.(value) ?? true;
                if (check !== true) {
                    problem.textContent = `>> ${check}`;
                    problem.setAttribute('role', 'alert');
                    this.sound.error();
                    return;
                }
                field.value = '';
                finish(value, kind === 'password' ? passwordEcho : value);
            };
            field.addEventListener('input', () => { problem.textContent = ''; });
            return {
                focus: () => field.focus({ preventScroll: true }),
                dispose: () => { field.value = ''; },
                onKey: event => {
                    if (event.key === 'Enter' && !event.repeat) { event.preventDefault(); submit(); }
                    // Escape means "leave empty" only where the prompt says empty is a valid way out.
                    else if (event.key === 'Escape' && validate?.('') === true) { event.preventDefault(); field.value = ''; submit(); }
                }
            };
        });
    }

    input(question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string> {
        return this.textPrompt('input', question);
    }

    password(question: { message: string; validate?: (input: string) => Validation }): Promise<string> {
        return this.textPrompt('password', question);
    }

    confirm(question: { message: string; default: boolean }): Promise<boolean> {
        const { message } = question;
        return this.ask<boolean>('confirm', message, (finish, block) => {
            const row = this.heading(message, question.default ? '(Y/n)' : '(y/N)');
            row.classList.add('field');
            const field = promptField('field-input short', `${message} y or n`);
            field.maxLength = 1;
            row.append(' ', field);
            block.append(row);
            field.addEventListener('input', () => { if (!/^[yYnN]$/.test(field.value)) field.value = ''; });
            const answer = (value: boolean): void => finish(value, value ? 'Yes' : 'No');
            return {
                focus: () => field.focus({ preventScroll: true }),
                dispose: () => { field.value = ''; },
                onKey: event => {
                    if (event.key === 'Enter' && !event.repeat) {
                        event.preventDefault();
                        answer(field.value ? field.value.toLowerCase() === 'y' : question.default);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        answer(false);
                    }
                }
            };
        });
    }

    autocomplete(question: { message: string; source: (input: string) => Array<Choice<string>> }): Promise<string> {
        const { message, source } = question;
        return this.ask<string>('autocomplete', message, (finish, block) => {
            const row = this.heading(message, '(Use arrow keys or type to search)');
            row.classList.add('field');
            const field = promptField('field-input', message);
            row.append(' ', field);
            const list = node('ul', 'choices');
            list.setAttribute('role', 'listbox');
            block.append(row, list);
            let items: Array<Choice<string>> = [];
            let view: ChoiceView;
            const refresh = (): void => {
                // Blank suggestions are how the shared flow echoes an empty input; there is nothing to show.
                items = source(field.value).filter(item => item.name !== '');
                list.replaceChildren();
                view = this.wire(items, list, 0, position => finish(items[position].value, items[position].name));
            };
            field.addEventListener('input', refresh);
            refresh();
            return {
                focus: () => field.focus({ preventScroll: true }),
                dispose: () => { field.value = ''; },
                onKey: event => {
                    if (event.key === 'ArrowDown') view.move(1);
                    else if (event.key === 'ArrowUp') view.move(-1);
                    else if (event.key === 'Enter' && !event.repeat) {
                        if (items.length) finish(items[view.index()].value, items[view.index()].name);
                        else finish(field.value, field.value);
                    } else if (event.key === 'Escape') finish('', '');
                    else return;
                    event.preventDefault();
                }
            };
        });
    }

    /**
     * Opens the file picker at once, riding the keypress that chose this action. The browser refuses a picker
     * without a recent user action; Enter then opens it. Dismissing the picker cancels the prompt.
     */
    chooseFile(message: string, accept: string): Promise<File | undefined> {
        return this.ask<File | undefined>('file', message, (finish, block) => {
            block.append(this.heading(message, '(Enter to browse, Esc to cancel)'));
            const field = promptField('file-input', message, 'file');
            field.accept = accept;
            field.hidden = true;
            block.append(field);
            field.addEventListener('change', () => { const file = field.files?.[0]; finish(file, file?.name ?? ''); });
            field.addEventListener('cancel', () => finish(undefined, ''));
            field.click();
            return {
                focus: () => {},
                dispose: () => { field.value = ''; },
                onKey: event => {
                    if (event.key === 'Enter' && !event.repeat) field.click();
                    else if (event.key === 'Escape') finish(undefined, '');
                    else return;
                    event.preventDefault();
                }
            };
        });
    }
}
