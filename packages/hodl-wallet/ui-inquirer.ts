import inquirer from 'inquirer';
import Table from 'cli-table3';
import ora from 'ora';
import { isPromptAborted } from './app/ui.js';
import type { Choice, Spinner, TableSpec, Ui, Validation } from './app/ui.js';

const AnyTable: any = Table;

/**
 * Ctrl+C ends the CLI through its SIGINT handler and leaves the prompt unsettled, as inquirer did
 * before it reported aborts as errors, so no caller can mistake the exit for a failed step.
 */
export async function exitOnAbort<T>(pending: Promise<T>): Promise<T> {
    try {
        return await pending;
    } catch (error) {
        if (!isPromptAborted(error)) throw error;
        process.kill(process.pid, 'SIGINT');
        return new Promise<T>(() => undefined);
    }
}

/** The terminal renderer of the shared flows. */
export class InquirerUi implements Ui {
    banner(art: string): void {
        console.log('\x1b[32m');
        console.log(art);
        console.log('\x1b[0m');
    }

    print(text: string): void {
        console.log(text);
    }

    table(spec: TableSpec): void {
        const table = new AnyTable({
            head: spec.head,
            style: { head: [spec.tone] },
            ...(spec.wordWrap ? { wordWrap: true } : {}),
            ...(spec.colWidths ? { colWidths: spec.colWidths } : {})
        });
        for (const row of spec.rows ?? []) table.push(row);
        console.log(table.toString());
    }

    async select<T>(question: { message: string; choices: Array<Choice<T>>; default?: T }): Promise<T> {
        const { answer } = await exitOnAbort(inquirer.prompt({ type: 'select', name: 'answer', ...question }));
        return answer;
    }

    async input(question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string> {
        const { answer } = await exitOnAbort(inquirer.prompt({ type: 'input', name: 'answer', ...question }));
        return answer;
    }

    async password(question: { message: string; validate?: (input: string) => Validation }): Promise<string> {
        const { answer } = await exitOnAbort(inquirer.prompt({ type: 'password', name: 'answer', mask: '*', toggleMask: false, ...question }));
        return answer;
    }

    async confirm(question: { message: string; default: boolean }): Promise<boolean> {
        const { answer } = await exitOnAbort(inquirer.prompt({ type: 'confirm', name: 'answer', ...question }));
        return answer;
    }

    async autocomplete(question: { message: string; source: (input: string) => Array<Choice<string>> }): Promise<string> {
        const { answer } = await exitOnAbort(inquirer.prompt({
            type: 'search',
            name: 'answer',
            message: question.message,
            source: (input?: string) => question.source(input || '')
        }));
        return answer;
    }

    spinner(text: string): Spinner {
        const spinner = ora({ text, spinner: 'dots' }).start();
        return {
            succeed: message => { spinner.succeed(message); },
            fail: message => { spinner.fail(message); },
            stop: () => { spinner.stop(); }
        };
    }
}
