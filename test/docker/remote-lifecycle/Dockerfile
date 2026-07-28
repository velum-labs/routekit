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
RUN useradd --create-home --shell /bin/bash --uid 1000 owner \
  && useradd --create-home --shell /bin/bash --uid 1001 peer \
  && chmod 0750 /home/owner /home/peer

COPY sshd_config /etc/ssh/sshd_config
COPY mock-provider.mjs /usr/local/lib/routekit-mock-provider.mjs
COPY entrypoint.sh /usr/local/bin/routekit-remote-entrypoint.sh
RUN chmod 0755 /usr/local/bin/routekit-remote-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/routekit-remote-entrypoint.sh"]
