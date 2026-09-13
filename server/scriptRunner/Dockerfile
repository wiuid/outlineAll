FROM docker:29.6.2-cli@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker-cli
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# Build context is produced by build.mjs using the existing Yarn lockfile.
# Only this trusted manager receives the dedicated rootless Docker socket.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /runner
COPY server ./server
COPY shared ./shared
COPY node_modules ./node_modules
USER 65532:0
ENV RUNNER_HOST=0.0.0.0 RUNNER_PORT=3035 RUNNER_STATE_DIR=/state RUNNER_TOKEN_FILE=/run/secrets/runner-token
EXPOSE 3035
ENTRYPOINT ["node", "/runner/server/scriptRunner/index.js"]
