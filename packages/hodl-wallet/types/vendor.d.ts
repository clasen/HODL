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
