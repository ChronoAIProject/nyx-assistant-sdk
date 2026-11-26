# Nyx Assistant SDK server

The Docker service forwards browser Agent Key request, poll, self and Nyx Responses calls to a fixed NyxID API origin. Each authenticated Responses request verifies its child credential with NyxID. An admitted model request can complete when its browser disconnects. The client recovers the stored answer by response ID.

Run `node server/server.mjs` with `NYXID_ORIGIN` and comma-separated `SDK_ORIGINS`. The default upstream is `https://nyx-api.chrono-ai.fun`. The server listens on `PORT` (8080 by default), with `GET /healthz` for chrono-cd. The relay uses no service secret or database. Each site stores its own encrypted child credential and links to the NyxID verification origin.

The SDK server image workflow publishes the linux/amd64 image to GHCR. The ChronoAI deployment uses project and app `nyx-assistant-sdk` in chrono-cd. The deployed image digest and public origins are recorded in `infra/chrono-cd/app.json`.
