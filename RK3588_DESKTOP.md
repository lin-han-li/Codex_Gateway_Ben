# RK3588 Desktop Package

If your RK3588 board has a desktop environment and you want to open Codex Gateway like a normal app from the launcher, use the Linux `arm64` desktop package instead of the server bundle.

## Which file to download

Recommended:

- `Codex Gateway-<version>-linux-arm64.deb`

Optional:

- `Codex Gateway-<version>-linux-arm64.AppImage`
- `Codex Gateway-<version>-linux-arm64.tar.gz`

Do not use the Linux `amd64` packages on RK3588.

## Install the normal desktop app

On the board:

```bash
sudo apt install ./Codex\ Gateway-1.1.17-linux-arm64.deb
```

After installation:

1. Open the application launcher.
2. Search for `Codex Gateway`.
3. Click the app icon to open it.

The desktop package bundles the local gateway server binary and launches the normal Electron desktop shell. You do not need to run `start.sh` or create a `systemd` service for normal desktop use.

## When to use the server bundle instead

Use `Codex-Gateway-server-rk3588-linux-arm64-<version>.tar.gz` only when you want a service-style deployment that runs in the background and is managed from shell scripts or `systemd`.
