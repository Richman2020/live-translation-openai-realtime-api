import { ConfigStore } from '../src/solo/config';

const store = new ConfigStore({ generateToken: false });
for (const { name, status } of store.checks())
  console.log(`${name}: ${status}`);
process.exitCode = store.configured() ? 0 : 1;
