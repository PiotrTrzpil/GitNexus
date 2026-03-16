// Type shims for dependencies that don't ship their own declarations
// or aren't direct dependencies (transitive only).

declare module 'path-scurry' {
  export interface Path {
    fullpath(): string;
    relative(): string;
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
}

declare module '@ladybugdb/core' {
  namespace lbug {
    class Database {
      constructor(...args: any[]);
      [key: string]: any;
    }
    class Connection {
      constructor(...args: any[]);
      [key: string]: any;
    }
  }
  export default lbug;
}
