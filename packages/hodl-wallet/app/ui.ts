export type Tone = 'green' | 'blue' | 'yellow' | 'red';
export type Cell = string | { colSpan: number; content: string };

export interface TableSpec {
    head: Cell[];
    rows?: Cell[][];
    tone: Tone;
    wordWrap?: boolean;
    colWidths?: number[];
    /** Holds secrets: a host may show it once but must not keep it in history. */
    secret?: boolean;
}

export interface Choice<T> {
    name: string;
    value: T;
    /** Selected by Escape in hosts that have one. */
    back?: boolean;
}

export interface Spinner {
    succeed(text: string): void;
    fail(text: string): void;
    stop(): void;
}

export type Validation = true | string;

/** Everything the shared flows need from a terminal, real or emulated. */
export interface Ui {
    banner(art: string): void;
    print(text: string): void;
    table(spec: TableSpec): void;
    select<T>(question: { message: string; choices: Array<Choice<T>>; default?: T }): Promise<T>;
    input(question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string>;
    password(question: { message: string; validate?: (input: string) => Validation }): Promise<string>;
    confirm(question: { message: string; default: boolean }): Promise<boolean>;
    autocomplete(question: { message: string; source: (input: string) => Array<Choice<string>> }): Promise<string>;
    spinner(text: string): Spinner;
}

/** Thrown by a pending prompt when the user exits or the wallet locks. Named like inquirer's Ctrl+C error. */
export class PromptAborted extends Error {
    constructor(message = 'Prompt was canceled.') {
        super(message);
        this.name = 'ExitPromptError';
    }
}

export function isPromptAborted(error: unknown): boolean {
    for (let current = error; current instanceof Error; current = current.cause) {
        if (current.name === 'ExitPromptError') return true;
    }
    return false;
}
