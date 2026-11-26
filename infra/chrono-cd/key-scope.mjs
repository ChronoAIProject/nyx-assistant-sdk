import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ORG, PROJECT, TARGETS, writableSpec } from './deploy.mjs';

const READ = '1b6d5e06-6f41-4cbb-8790-ed40192f982f';
const WRITE = '4b998cbc-e192-4f02-970b-dfb450846fed';
const STATUS = '770b8512-024a-4a8d-b162-040f3bef45e9';
const exact = (value) => ({ type: 'exact', value });
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });

export function keyScope(app, environment) {
  const target = Object.values(TARGETS).find((item) => item.environment === environment);
  if (!target) throw new Error('Unknown deployment environment');
  const spec = writableSpec(app, target);
  const properties = Object.fromEntries(Object.entries(spec).map(([name, value]) => [name, exact(value)]));
  const service = Object.fromEntries(Object.entries(spec.services[target.service]).map(([name, value]) =>
    [name, name === 'image' ? { type: 'string', max_length: 256 } : exact(value)]));
  properties.services = object({ [target.service]: object(service) });
  const limits = {
    path: { project: exact(PROJECT), app: exact(target.app) },
    query: { org_id: { required: true, rule: exact(ORG) } },
  };
  return { [READ]: limits, [WRITE]: { ...limits, body: object(properties) }, [STATUS]: limits };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , environment] = process.argv;
    console.log(JSON.stringify(keyScope(JSON.parse(readFileSync(0, 'utf8')), environment), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
