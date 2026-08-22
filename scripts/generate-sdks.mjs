import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = process.env.SDK_VERSION || '1.1.0';
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const output = `${root}/build/sdk/`;
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const image = JSON.parse(readFileSync(new URL('../sdk/generator.json', import.meta.url), 'utf8')).image;
const runs = [
  ['typescript-fetch', 'typescript', `npmName=@rockygpt/data-client,npmVersion=${version},supportsES6=true`],
  ['swift5', 'swift', 'projectName=RockyGPTDataSDK,podSourceFolder=Sources,responseAs=AsyncAwait,swiftPackagePath=RockyGPTDataSDK'],
  ['kotlin', 'kotlin', `artifactId=rockygpt-data-sdk,groupId=com.rockygpt,packageName=com.rockygpt.data.sdk,artifactVersion=${version},library=jvm-retrofit2`],
];
for (const [generator, folder, properties] of runs) {
  const user = process.getuid ? [`--user`, `${process.getuid()}:${process.getgid()}`] : [];
  const result = spawnSync('docker', ['run', '--rm', ...user, '-v', `${root}:/local`, image,
    'generate', '-i', '/local/api/openapi.yaml', '-g', generator, '-o', `/local/build/sdk/${folder}`,
    '--additional-properties', properties], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
