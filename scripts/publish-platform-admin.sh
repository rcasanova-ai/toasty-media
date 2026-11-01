#!/bin/bash
set -euo pipefail
bash scripts/publish-website.sh
curl --fail --silent --show-error --location https://toasty.media/admin/ -o /tmp/admin-check.html
curl --fail --silent --show-error --location https://toasty.media/js/platform-admin.js -o /tmp/platform-admin-check.js
grep -Fq 'People & access' /tmp/admin-check.html
grep -Fq 'async function createMember' /tmp/platform-admin-check.js
