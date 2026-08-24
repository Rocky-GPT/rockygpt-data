import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const spec = parse(await readFile(new URL('../api/openapi.yaml', import.meta.url), 'utf8'));
if (!spec || !/^3\.1\./.test(spec.openapi) || !/^\d+\.\d+\.\d+$/.test(spec.info?.version || '')) {
  throw new Error('OpenAPI 3.1 and a semantic info.version are required.');
}
const operationIds = new Set();
for (const [path, item] of Object.entries(spec.paths || {})) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (!item?.[method]) continue;
    const id = item[method].operationId;
    if (!id || operationIds.has(id)) throw new Error(`Missing or duplicate operationId at ${method.toUpperCase()} ${path}.`);
    operationIds.add(id);
  }
}
function resolvePointer(ref) {
  if (!ref.startsWith('#/')) throw new Error(`Only local OpenAPI references are allowed: ${ref}`);
  let value = spec;
  for (const part of ref.slice(2).split('/').map((entry) => entry.replaceAll('~1', '/').replaceAll('~0', '~'))) value = value?.[part];
  if (value === undefined) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
}
function walk(value) {
  if (Array.isArray(value)) return value.forEach(walk);
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') resolvePointer(value.$ref);
  Object.values(value).forEach(walk);
}
walk(spec);

const server = await readFile(new URL('../api/server.ts', import.meta.url), 'utf8');
const documented = new Set(
  Object.entries(spec.paths || {}).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete']
      .filter((method) => item?.[method])
      .map((method) => `${method.toUpperCase()} ${path}`)
  )
);
for (const match of server.matchAll(/'(GET|POST|PUT|PATCH|DELETE) ([^']+)':/g)) {
  const operation = `${match[1]} ${match[2]}`;
  if (!match[2].includes('/dev/') && !documented.has(operation)) {
    throw new Error(`Runtime route is absent from OpenAPI: ${operation}`);
  }
}
for (const operation of documented) {
  if (operation === 'GET /v1/data/{artifact}') continue;
  if (!server.includes(`'${operation}'`)) {
    throw new Error(`OpenAPI route is not registered at runtime: ${operation}`);
  }
}
console.log(`OpenAPI ${spec.info.version}: ${operationIds.size} unique operations, all refs resolved and routes covered.`);
