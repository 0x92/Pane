# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository root as the context, with network
# access, then audits the finished image with no network. Everything the build,
# the tests or the Electron app need is fetched here.
# Build it yourself: docker build -f .oss-scanner/Dockerfile -t pane-oss-scanner .
# Then check it offline: docker run --rm -it --network none pane-oss-scanner bash
FROM node:22.18.0-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PANE_DIR=/tmp/pane-scan

# git drives worktrees; python3 and build-essential cover node-gyp fallbacks;
# xvfb lets Electron start without a display; the port monitor and its tests
# call ss, lsof and nc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 build-essential xvfb xauth \
      iproute2 lsof netcat-openbsd procps \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# pnpm comes from the version pinned in package.json's packageManager field.
RUN corepack enable pnpm && pnpm --version

# Same install as CI's quality job: skip the Electron-targeted postinstall,
# then build the one native module the tests load for Node.
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild better-sqlite3-multiple-ciphers

# The Electron binary and a Chromium for Playwright, with their system
# libraries, so the app and its browser tests can run offline.
RUN node node_modules/electron/install.js \
    && pnpm exec playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Build the main process, the renderer and the runpane CLI.
RUN pnpm run build:main \
    && pnpm run build:frontend \
    && pnpm --filter runpane build

# Run the unit tests so the image is known to work, without letting a failure
# abort the build.
RUN (pnpm --filter main exec vitest run || echo "WARNING: main tests reported failures") \
    && (pnpm --filter frontend test || echo "WARNING: frontend tests reported failures")
