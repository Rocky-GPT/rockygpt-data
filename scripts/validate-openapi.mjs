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
const documented = new Set(Object.keys(spec.paths));
for (const match of server.matchAll(/'GET ([^']+)':/g)) {
  if (!match[1].includes('/dev/') && !documented.has(match[1])) throw new Error(`Runtime route is absent from OpenAPI: GET ${match[1]}`);
}
for (const path of documented) {
  if (path === '/v1/data/{artifact}') continue;
  if (!server.includes(`'GET ${path}'`) && path !== '/health' && path !== '/readiness') {
    throw new Error(`OpenAPI route is not registered at runtime: GET ${path}`);
  }
}
console.log(`OpenAPI ${spec.info.version}: ${operationIds.size} unique operations, all refs resolved and routes covered.`);
