# Linux SSH target for RouteKit remote lifecycle E2E.
# Two unprivileged users, key-only OpenSSH, no preinstalled RouteKit.
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server \
    ca-certificates \
    curl \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/run/sshd \
  && ssh-keygen -A

# Owner runs the shared daemon; peer enrolls against it.
# The base image already owns uid 1000 (`node`); pick free uids.
# `usermod -p '*'` unlocks the account for pubkey SSH while leaving no
# usable password hash (sshd rejects locked `!` accounts even for keys).
RUN useradd --create-home --shell /bin/bash --uid 1100 owner \
  && useradd --create-home --shell /bin/bash --uid 1101 peer \
  && usermod -p '*' owner \
  && usermod -p '*' peer \
  && chmod 0750 /home/owner /home/peer

COPY sshd_config /etc/ssh/sshd_config
COPY mock-provider.mjs /usr/local/lib/routekit-mock-provider.mjs
COPY entrypoint.sh /usr/local/bin/routekit-remote-entrypoint.sh
RUN chmod 0755 /usr/local/bin/routekit-remote-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/routekit-remote-entrypoint.sh"]
