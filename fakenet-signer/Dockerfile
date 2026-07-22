# Runtime image for the fakenet MPC responder (fakenet-signer workspace).
# Build from the REPO ROOT so yarn.lock + workspace hoisting resolve as in dev:
#   docker build -f fakenet-signer/Dockerfile -t ghcr.io/sig-net/fakenet:dev .
# Published to ghcr.io/sig-net/fakenet on fakenet-v* tags
# (.github/workflows/fakenet-docker-publish.yml).
#
# glibc base (never alpine/musl): classic-level ships glibc prebuilds and the
# Midnight SDKs load WASM/native artifacts that are untested on musl.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Manifests first for layer caching. Both workspace package.jsons are needed
# for yarn-1 workspace resolution even though only fakenet-signer runs here.
COPY package.json yarn.lock ./
COPY fakenet-signer/package.json fakenet-signer/
COPY signet-program/package.json signet-program/
RUN yarn install --frozen-lockfile --production && yarn cache clean

# Source + committed runtime assets (idl/). The signet contract's zk
# artifacts (incl. prover keys) come from the @sig-net/midnight-contract
# npm package installed above.
COPY fakenet-signer/ fakenet-signer/

# cwd matters: the LevelDB private state is created at ./midnight-level-db
# (fresh per container recreate — intentional, it is a single-writer store
# tied to the deployed contract), and EnvConfig's optional dotenv file
# resolves to /app/.env, which is absent — config comes from the environment.
WORKDIR /app/fakenet-signer
CMD ["/app/node_modules/.bin/tsx", "src/cli/Run.ts"]
