import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');

export const VERSION: string = pkg.version;
