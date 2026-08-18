# Cursor Cloud environment notes

These notes describe the current cloud VM, not RouteKit architecture.

## Node and pnpm

- The repository requires Node >= 22.22.0 and pnpm 11.15.1 via Corepack.
- A non-login shell may resolve `/exec-daemon/node` v22.14.0. If pnpm reports
  an engine mismatch, run:

  ```sh
  . "$HOME/.nvm/nvm.sh"
  nvm use 22.22.2
  ```

- Login shells and tmux sessions normally select Node v22.22.2.

## Docker

- Docker CE 28.5.2 is installed, but systemd is not active. Start the daemon in
  a tmux window:

  ```sh
  sudo dockerd > /tmp/dockerd.log 2>&1
  ```

- Keep the configured `fuse-overlayfs` storage driver and iptables-legacy.
  Docker-in-Docker on this VM depends on both.
- The `ubuntu` user receives docker-group access in a fresh login shell;
  otherwise use `sudo docker`.
- If Docker must be reinstalled, install `docker-ce`, `docker-ce-cli`,
  `containerd.io`, and `fuse-overlayfs`, then restore the existing daemon and
  iptables configuration.

## Remote testing over SSH

- Stop the host RouteKit daemon before a container binds port 8080.
- Run the test container with `--network host`. The container gateway is then
  reachable at `http://127.0.0.1:8080` and sshd at `127.0.0.1:22`.
- Configure key authentication with `BatchMode yes`,
  `StrictHostKeyChecking no`, and an explicit `IdentityFile`.
- A reusable image can start from `node:22-bookworm-slim`, install
  `openssh-server` and `@velum-labs/routekit`, add the public key to
  `/root/.ssh/authorized_keys`, run `ssh-keygen -A`, and start sshd with:

  ```sh
  exec /usr/sbin/sshd -D
  ```

- Configure the container daemon with an OpenAI provider pointed at a local
  OpenAI-compatible mock, then test from the host:

  ```sh
  routekit remote add testvm --url http://127.0.0.1:8080 --ssh testvm
  routekit remote use testvm
  routekit --remote testvm status
  ```

- Non-loopback remote URLs require HTTPS. The host-network recipe deliberately
  uses the shared loopback interface.
