import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import type http from 'node:http';
import { createDataServer } from './server';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('a malformed Host header cannot terminate the data service', async () => {
  const server = createDataServer();
  const port = await listen(server);
  try {
    const first = await rawRequest(
      port,
      'GET /health HTTP/1.1\r\nHost: ]\r\nConnection: close\r\n\r\n'
    );
    assert.match(first, /^HTTP\/1\.1 200 /);

    const second = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { status?: unknown }).status, 'healthy');
  } finally {
    await close(server);
  }
});

test('oversized request targets are rejected without taking down the server', async () => {
  const server = createDataServer();
  const port = await listen(server);
  try {
    const response = await rawRequest(
      port,
      `GET /health?q=${'x'.repeat(8_300)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
    );
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await close(server);
  }
});

test('staging token gates data routes while probes stay public', async () => {
  const server = createDataServer({ ...process.env, STAGING_SERVICE_TOKEN: 'stage-secret' });
  const port = await listen(server);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/map`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/map`, {
      headers: { 'x-rockygpt-environment-token': 'wrong' },
    })).status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/v1/map`, {
      headers: { 'x-rockygpt-environment-token': 'stage-secret' },
    });
    assert.notEqual(allowed.status, 401);
  } finally {
    await close(server);
  }
});
