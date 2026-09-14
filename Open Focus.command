#!/bin/zsh
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print 'Node.js 24 or later is needed to run Focus.'
  read -k 1
  exit 1
fi
if [ ! -d node_modules ]; then npm ci || exit 1; fi
if [ ! -d .next ]; then npm run build || exit 1; fi
node scripts/open.mjs
