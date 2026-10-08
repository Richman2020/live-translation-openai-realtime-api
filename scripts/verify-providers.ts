import { ConfigStore } from '../src/solo/config';
import { verifyProviders } from '../src/solo/provider-checks';

const result = await verifyProviders(
  new ConfigStore({ generateToken: false }).value,
);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.checks.every((check) => check.status === 'passed')
  ? 0
  : 1;
