declare module "deepbase" {
    export default class Deepbase {
        constructor(opts: Record<string, unknown>);
        get(...path: string[]): any;
        set(...args: unknown[]): void | Promise<void>;
        add(...args: unknown[]): void | Promise<void>;
        del(...path: string[]): void | Promise<void>;
        entries(...path: string[]): Array<[string, any]>;
        values(...path: string[]): any[];
    }
}

declare module "hdkey" {
    type HDKeyNode = {
        privateKey: Buffer;
        derive(path: string): HDKeyNode;
    };

    const hdkey: {
        fromMasterSeed(seed: Buffer | Uint8Array): HDKeyNode;
    };

    export default hdkey;
}

declare module "inquirer";
declare module "inquirer-autocomplete-prompt";
