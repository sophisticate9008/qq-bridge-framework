import { acquireProcessFileLock } from '../../src/storage/process-file-lock.ts';
const directory = process.argv[2];
if (!directory) throw new Error('Fixture directory required');
await acquireProcessFileLock(directory, 'operation.lock');
process.stdout.write('ready\n');
setInterval(() => undefined, 1000);
