import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploy, ORG, PROJECT, TARGETS } from './deploy.mjs';
import { keyScope } from './key-scope.mjs';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const image = `ghcr.io/chronoaiproject/nyx-assistant-sdk-server:${sha}@${digest}`;
const target = TARGETS['refs/heads/dev'];
const service = target.service;
const input = { ref: 'refs/heads/dev', environment: 'staging', sha, digest, key: 'example' };
const current = {
  project: PROJECT,
  name: target.app,
  owner: ORG,
  generation: 7,
  revision: 6,
  spec: {
    services: {
      [service]: {
        image: 'previous',
        image_digest: 'previous-digest',
        env: { SDK_ORIGINS: 'https://example.com' },
      },
    },
  },
};
const applied = {
  ...current,
  generation: 8,
  revision: 7,
  spec: { services: { [service]: { ...current.spec.services[service], image, image_digest: digest } } },
};
const ready = {
  phase: 'ready',
  last_reconcile: { ok: true, revision: 7 },
  services: { [service]: { pods: [{ ready: true, app_container: { image_id: image } }] } },
};

function mock(responses) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(responses.length, 'unexpected HTTP request');
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  };
  return { calls, request, pause: async () => {} };
}

test('deploys the exact image with If-Match, keeps the live settings and verifies public health', async () => {
  const io = mock([current, applied, ready, applied, new Response('ok')]);
  const result = await deploy(input, io);
  const [read, put, status, verify, health] = io.calls;
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['If-Match'], '7');
  assert.equal(put.headers['X-API-Key'], 'example');
  assert.ok(put.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(put.body), {
    services: { [service]: { image, env: current.spec.services[service].env } },
  });
  assert.equal(read.url, put.url);
  assert.equal(verify.url, put.url);
  assert.match(status.url, /\/nyx-assistant-sdk-staging\/status\?org_id=/);
  assert.equal(health.url, `${target.url}/healthz`);
  assert.equal(health.headers, undefined);
  assert.deepEqual(result, { app: target.app, environment: 'staging', url: target.url, revision: 7, sha, digest });
});

test('rejects invalid or mismatched deployment inputs before sending any requests', async () => {
  const io = mock([]);
  for (const invalid of [
    { ref: 'refs/tags/dev' }, { environment: 'production' }, { digest: 'latest' },
    { sha: 'abcdef0' }, { key: '' },
  ]) {
    await assert.rejects(deploy({ ...input, ...invalid }, io));
  }
  assert.equal(io.calls.length, 0);
});

test('rejects a stale generation without retrying or exposing the CD response', async () => {
  const io = mock([current, new Response('private detail', { status: 409 })]);
  await assert.rejects(deploy(input, io), { message: 'chrono-cd PUT returned HTTP 409' });
  assert.equal(io.calls.length, 2);
});

test('reports an unverified rollout when status, Pod digest, generation or public health differ', async () => {
  for (const [status, actual, health, error] of [
    [{ ...ready, phase: 'progressing' }, applied, new Response('ok'), /progressing/],
    [{ ...ready, services: { [service]: { pods: [{ ready: true, app_container: { image_id: 'old' } }] } } }, applied, new Response('ok'), /running Pod/],
    [ready, { ...applied, generation: 9 }, new Response('ok'), /generation/],
    [ready, applied, new Response('unavailable', { status: 503 }), /health check/],
  ]) {
    await assert.rejects(deploy(input, mock([current, applied, status, actual, health])), error);
  }
});

test('the same digest can be verified again without a second PUT', async () => {
  const io = mock([applied, ready, applied, new Response('ok')]);
  await deploy(input, io);
  assert.equal(io.calls.filter(({ method }) => method === 'PUT').length, 0);
});

test('limits the key to the app, organization and unchanged live settings', () => {
  const scope = keyScope(current, 'staging');
  const operations = Object.values(scope);
  assert.equal(operations.length, 3);
  for (const operation of operations) {
    assert.deepEqual(operation.path, {
      project: { type: 'exact', value: PROJECT },
      app: { type: 'exact', value: target.app },
    });
    assert.deepEqual(operation.query, { org_id: { required: true, rule: { type: 'exact', value: ORG } } });
  }
  const body = operations.find(operation => operation.body).body;
  assert.deepEqual(body.properties.services.properties[service].properties, {
    image: { type: 'string', max_length: 256 },
    env: { type: 'exact', value: current.spec.services[service].env },
  });
  assert.throws(() => keyScope(current, 'production'), /target/);
});
