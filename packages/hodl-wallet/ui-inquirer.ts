import inquirer from 'inquirer';
import inquirerAutocomplete from 'inquirer-autocomplete-prompt';
import Table from 'cli-table3';
import ora from 'ora';
import type { Choice, Spinner, TableSpec, Ui, Validation } from './app/ui.js';

inquirer.registerPrompt('autocomplete', inquirerAutocomplete);

const AnyTable: any = Table;

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
        const { answer } = await inquirer.prompt({ type: 'list', name: 'answer', ...question });
        return answer;
    }

    async input(question: { message: string; default?: string; validate?: (input: string) => Validation }): Promise<string> {
        const { answer } = await inquirer.prompt({ type: 'input', name: 'answer', ...question });
        return answer;
    }

    async password(question: { message: string; validate?: (input: string) => Validation }): Promise<string> {
        const { answer } = await inquirer.prompt({ type: 'password', name: 'answer', mask: '*', ...question });
        return answer;
    }

    async confirm(question: { message: string; default: boolean }): Promise<boolean> {
        const { answer } = await inquirer.prompt({ type: 'confirm', name: 'answer', ...question });
        return answer;
    }

    async autocomplete(question: { message: string; source: (input: string) => Array<Choice<string>> }): Promise<string> {
        const { answer } = await inquirer.prompt({
            type: 'autocomplete',
            name: 'answer',
            message: question.message,
            source: (_answers: Record<string, unknown>, input?: string) => question.source(input || '')
        });
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
