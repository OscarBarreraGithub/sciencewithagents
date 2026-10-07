# Build only this public reviewed directory; never send the repo/data/native homes.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG CODEX_VERSION=0.159.2
ARG CLAUDE_VERSION=2.1.288
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client chromium xvfb python3 build-essential ripgrep util-linux bubblewrap texlive-latex-base texlive-latex-recommended texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --ignore-scripts --no-audit --no-fund \
      @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION}
# Reviewed provider postinstall places the bundled Linux binary in this IMAGE.
# It never runs on the host and never signs in or reads a host credential store.
RUN node /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs \
    && codex --version && claude --version
WORKDIR /opt/dock
RUN npm install --ignore-scripts --no-audit --no-fund ws@8.18.3 \
    && usermod --login agent --home /home/agent --shell /bin/bash node \
    && mkdir -p /home/agent \
    && printf 'Host *\n  ProxyCommand node /opt/dock/connect.mjs %%h %%p\n' > /etc/ssh/ssh_config.d/group-network.conf
COPY init.mjs rpc-relay.mjs connect.mjs claude-stream.mjs chromium canary.py group-documents.py /opt/dock/
RUN chmod 755 /opt/dock/chromium
RUN ln -s /home/agent/workspace /workspace
ENV HOME=/home/agent CODEX_HOME=/home/agent/.codex CLAUDE_CONFIG_DIR=/home/agent/.claude \
    HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128 \
    ALL_PROXY=http://127.0.0.1:3128 NO_PROXY= \
    CHROME_BIN=/opt/dock/chromium DISPLAY=:99
ARG SOURCE_DIGEST
LABEL io.sciencewithagents.group-runtime-schema="1" io.sciencewithagents.group-source="${SOURCE_DIGEST}"
ENTRYPOINT ["node", "/opt/dock/init.mjs"]
