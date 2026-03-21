# Git LFS On-Demand

Visual Studio Code extension that pulls Git LFS files on demand when opened.

## Features

Pulls LFS pointer files when opened.
Also pull referenced images and downloads from `.rst` and `.md` files.

## Requirements

Git LFS installed with `--skip-smudge`:
```
# Global (preferred)
git lfs install --local --force --skip-smudge
# Local
GIT_LFS_SKIP_SMUDGE=1 git clone repo https:///...
cd repo
git lfs install --local --force --skip-smudge
```

## Usage

Open any file tracked by LFS. The extension detects pointers and pulls automatically.

Manual pull: Command Palette -> "Git LFS: Pull Current File"

## GitHub Enterprise Managed Users

GitHub Enterprise Managed Users (EMU) may not be able to download Git LFS objects from public repositories. EMU accounts can be configured to be restricted to enterprise resources and to not authenticate to external LFS servers.
Use another, non-EMU, credential.

## Get

[Open VSX Registry](https://open-vsx.org/extension/gastmaier/git-lfs-on-demand) or
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=gastmaier.git-lfs-on-demand)

## Build

See the ./Makefile and/or ./.github/workflows.
