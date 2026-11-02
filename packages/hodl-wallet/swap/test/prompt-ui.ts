import assert from 'node:assert/strict';
import type { Choice, Spinner, TableSpec, Ui, Validation, Watch } from '../../app/ui.js';

export type Question = {
    /** The swap prompt, named by its message. */
    name: string;
    kind: 'select' | 'input' | 'confirm' | 'autocomplete';
    message: string;
    choices?: Array<Choice<unknown>>;
    default?: unknown;
    validate?: (input: string) => Validation;
    source?: (input: string) => Array<Choice<string>>;
};

const names: Array<[RegExp, string]> = [
    [/^Swap:$/, 'route'], [/ to exchange /, 'amount'], [/^Receive /, 'destination'],
    [/^Choose a quote:$/, 'quoteId'], [/^Accept destination/, 'confirmed'], [/^Select a swap:$/, 'requestId']
];

/** Answers each prompt through a handler. Like a real terminal, nothing may print or ask while a spinner runs. */
export class PromptUi implements Ui {
    readonly output: string[] = [];
    spinning = false;
    private leave?: () => void;

    constructor(private readonly answer: (question: Question) => unknown) {}

    private idle(): void { assert.equal(this.spinning, false, 'Output or prompt while a spinner runs'); }

    private async ask<T>(question: Omit<Question, 'name'>): Promise<T> {
        this.idle();
        const name = names.find(([pattern]) => pattern.test(question.message))?.[1] ?? question.message;
        const answer = await this.answer({ name, ...question });
        if (question.validate) assert.equal(question.validate(String(answer)), true, `Rejected answer to ${question.message}`);
        return answer as T;
    }

    banner(): void {}
    print(text: string): void { this.idle(); this.output.push(text); }
    table(spec: TableSpec): void {
        this.idle();
        for (const row of [spec.head, ...(spec.rows ?? [])]) this.output.push(row.map(cell => typeof cell === 'string' ? cell : cell.content).join(' '));
    }
    select<T>(question: { message: string; choices: Array<Choice<T>>; default?: T }): Promise<T> { return this.ask({ kind: 'select', ...question }); }
    input(question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string> { return this.ask({ kind: 'input', ...question }); }
    password(): Promise<string> { throw new Error('Swaps never ask for a password.'); }
    confirm(question: { message: string; default: boolean }): Promise<boolean> { return this.ask({ kind: 'confirm', ...question }); }
    autocomplete(question: { message: string; source: (input: string) => Array<Choice<string>> }): Promise<string> { return this.ask({ kind: 'autocomplete', ...question }); }

    spinner(): Spinner {
        this.idle();
        this.spinning = true;
        const stop = (): void => { this.spinning = false; };
        return { succeed: stop, fail: stop, stop };
    }

    watch(): Watch {
        this.idle();
        this.spinning = true;
        const left = new Promise<void>(resolve => { this.leave = () => { this.spinning = false; resolve(); }; });
        return {
            update: () => { this.spinning = true; },
            pause: () => { this.spinning = false; },
            stop: () => { this.spinning = false; },
            left
        };
    }

    /** Presses Enter on the running watch. */
    leaveWatch(): void {
        assert.ok(this.leave, 'No watch is running');
        this.leave();
    }
}
