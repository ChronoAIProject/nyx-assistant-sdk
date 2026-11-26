# Nyx Assistant SDK server

The Docker service forwards browser Agent Key request, poll, self and Nyx Responses calls to a fixed NyxID API origin. Each authenticated Responses request verifies its child credential with NyxID. An admitted model request can complete when its browser disconnects. The client recovers the stored answer by response ID.

Install relay dependencies with `npm ci --prefix server`. Run `node server/server.mjs` with `NYXID_ORIGIN` and comma-separated `SDK_ORIGINS`. The default upstream is `https://nyx-api.chrono-ai.fun`. The server listens on `PORT` (8080 by default), with `GET /healthz` for chrono-cd. The relay uses no service secret or database. Each site stores its own encrypted child credential and links to the NyxID verification origin.

The relay also forwards Bot Voice discovery, options, sessions and controls. Browser WebSockets authenticate with a child credential in the first frame. The relay verifies the child and opens the exact NyxID session stream with its Authorization header. Configure the front proxy to forward WebSocket upgrades.

## Continuous deployment

The [SDK server workflow](../.github/workflows/server-image.yml) runs the relay and deployment tests before publishing the linux/amd64 image to GHCR. It deploys the digest returned by that build for server and deployment changes on either branch. You can also dispatch the workflow at either branch's current tip. The `sdk-server-*` tags publish images for manual use.

| Branch | GitHub environment | chrono-cd app in `nyx-assistant-sdk` | Public health check |
|---|---|---|---|
| `dev` | `staging` | `nyx-assistant-sdk-staging` | [Staging](https://nyx-assistant-sdk-staging-chronoai.apps.nyxid.ai/healthz) |
| `main` | `production` | `nyx-assistant-sdk` | [Production](https://nyx-assistant-sdk-chronoai.apps.nyxid.ai/healthz) |

Merge server changes into `dev` and verify the staging run. Promote to production by merging `dev` into `main`. The deploy job reads the live app, updates its image with an `If-Match` generation guard, then checks the applied revision, running Pod digest and public `/healthz`. The workflow summary records the verified revision and digest. [Metaverse deployment reference](https://github.com/ChronoAIProject/chrono-metaverse/blob/d1e0dd1132118f67dc422b5b3a85d7e3e83f53a2/.github/workflows/publish.yml)

The [production spec](../infra/chrono-cd/app.json) and [staging spec](../infra/chrono-cd/app.staging.json) are bootstrap inputs. Review changes to site origins or other settings against the live spec in chrono-cd. After applying a configuration change, refresh the environment's key scope from the live app JSON with `node infra/chrono-cd/key-scope.mjs staging < live-app.json` (use `production` for `main`).

Each GitHub environment stores a separate `CHRONO_CD_API_KEY` with NyxID `proxy` scope for chrono-cd. The scope file limits GET app, GET status, and PUT app to one organization, project and application. The PUT permits changing only the image. Supply the generated JSON to `nyxid api-key operations` using `--service chrono-cd --inputs` and an `--allow-endpoint` for each of its three operation IDs. Update the environment secret when rotating its key.
