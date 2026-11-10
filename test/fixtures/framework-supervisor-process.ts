import { superviseFramework } from '../../scripts/framework-supervisor.ts';
const [root, configuration] = process.argv.slice(2);
if (!root || !configuration) throw new Error('fixture_arguments_required');
await superviseFramework(root, ['--config', configuration]);
