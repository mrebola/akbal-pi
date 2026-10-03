// Minimal typings for the parts of adm-zip the .akbal package uses.
declare module "adm-zip" {
  interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    header: { size: number };
    getData(): Buffer;
  }
  class AdmZip {
    constructor(input?: Buffer | string);
    addFile(entryName: string, content: Buffer): void;
    getEntries(): ZipEntry[];
    toBuffer(): Buffer;
  }
  export default AdmZip;
}
