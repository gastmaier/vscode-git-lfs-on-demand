help:
	@echo "Available commands:"
	@echo "  all: build, then install"
	@echo "  build: build vsix package"
	@echo "  install: install to vscod[e|ium]"
	@echo "  clean: clean cache"

all: build install

build:
	npm install
	npm run compile
	npx @vscode/vsce package

install:
	command -v codium && codium --install-extension git-lfs-on-demand-*.vsix --force || true
	command -v code && code --install-extension git-lfs-on-demand-*.vsix --force || true

clean:
	rm -rf dist node_modules *.vsix
