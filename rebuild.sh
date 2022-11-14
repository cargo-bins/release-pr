#!/bin/bash

set -euxo pipefail

npm run all
git commit -am rebuild || true

vtarget="${1:-patch}"
version=$(jq -r .version package.json)
if [[ "$version" != "$vtarget" ]]; then
	npm version $vtarget
fi

version=$(jq -r .version package.json)
short_tag=$(cut -d. -f1 <<< "$version")

git push
git tag -sfam "v$short_tag floating tag" "v$short_tag"
git push --tags --force
