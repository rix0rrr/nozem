import { readJsonIfExists, writeJson } from "./files";

export class CacheFile<A extends object> {
  constructor(private readonly fileName: string) {
  }

  public read(): Promise<A | undefined> {
    return readJsonIfExists<A>(this.fileName);
  }

  public write(content: A) {
    return writeJson(this.fileName, content);
  }
}