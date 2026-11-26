import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const ORG = '52aa284c-b5b2-49bd-9d12-79f24772dbd7';
export const PROJECT = 'nyx-assistant-sdk';
export const TARGETS = {
  'refs/heads/dev': {
    environment: 'staging',
    app: 'nyx-assistant-sdk-staging',
    service: 'sdk-server-staging',
    url: 'https://nyx-assistant-sdk-staging-chronoai.apps.nyxid.ai',
  },
  'refs/heads/main': {
    environment: 'production',
    app: 'nyx-assistant-sdk',
    service: 'sdk-server',
    url: 'https://nyx-assistant-sdk-chronoai.apps.nyxid.ai',
  },
};
const PROXY = 'https://nyx-api.chrono-ai.fun/api/v1/proxy/s/chrono-cd/api/v1';
const IMAGE = 'ghcr.io/chronoaiproject/nyx-assistant-sdk-server';

export function writableSpec(app, target) {
  const spec = structuredClone(app?.spec);
  const services = spec?.services;
  if (app?.project !== PROJECT || app.name !== target.app || app.owner !== ORG
      || !services || Object.keys(services).length !== 1
      || typeof services[target.service]?.image !== 'string') {
    throw new Error('chrono-cd application does not match the deployment target');
  }
  delete services[target.service].image_digest;
  return spec;
}

export async function deploy({ ref, environment, sha, digest, key }, { request = fetch, pause = delay } = {}) {
  const target = TARGETS[ref];
  if (!target || environment !== target.environment) throw new Error('Branch and deployment environment do not match');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Deployment requires a full commit SHA');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Deployment requires the published image digest');
  if (!key) throw new Error('CHRONO_CD_API_KEY is required');
  const image = `${IMAGE}:${sha}@${digest}`;
  const path = `${PROXY}/projects/${PROJECT}/apps/${target.app}`;

  async function api(suffix = '', { method = 'GET', headers, body } = {}) {
    let response;
    try {
      response = await request(`${path}${suffix}?org_id=${ORG}`, {
        method, body, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json', ...headers },
      });
    } catch {
      throw new Error(`chrono-cd ${method} ${suffix || 'app'} request failed`);
    }
    if (!response.ok) throw new Error(`chrono-cd ${method} returned HTTP ${response.status}`);
    return response.json();
  }

  const current = await api();
  const spec = writableSpec(current, target);
  if (!Number.isSafeInteger(current.generation)) throw new Error('Missing chrono-cd generation');
  let applied = current;
  if (spec.services[target.service].image !== image) {
    spec.services[target.service].image = image;
    applied = await api('', {
      method: 'PUT', headers: { 'If-Match': String(current.generation) }, body: JSON.stringify(spec),
    });
    // PUT completes reconciliation. Give the cluster one rollout window before checking live state.
    await pause(90_000);
  }

  const status = await api('/status');
  if (status.phase !== 'ready') throw new Error(`chrono-cd rollout is ${status.phase}`);
  if (status.last_reconcile?.ok !== true || status.last_reconcile.revision !== applied.revision) {
    throw new Error('chrono-cd status does not match the applied revision');
  }
  const pods = status.services?.[target.service]?.pods?.filter((pod) => pod.ready);
  if (!pods?.length || !pods.every((pod) => pod.app_container?.image_id?.endsWith(`@${digest}`))) {
    throw new Error('The running Pod image does not match the published digest');
  }
  const actual = await api();
  if (actual.generation !== applied.generation || actual.revision !== applied.revision) {
    throw new Error('The application generation changed during verification');
  }
  if (actual.spec?.services?.[target.service]?.image_digest !== digest) {
    throw new Error('The applied image does not match the published digest');
  }
  const health = await request(`${target.url}/healthz`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!health.ok || await health.text() !== 'ok') throw new Error('The public health check failed');
  return { app: target.app, environment, url: target.url, revision: actual.revision, sha, digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await deploy({
      ref: process.env.GITHUB_REF, environment: process.env.DEPLOY_ENVIRONMENT,
      sha: process.env.GITHUB_SHA, digest: process.env.IMAGE_DIGEST, key: process.env.CHRONO_CD_API_KEY,
    });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `Deployed [${result.app}](${result.url}) at revision ${result.revision} with \`${result.sha}@${result.digest}\`.\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
