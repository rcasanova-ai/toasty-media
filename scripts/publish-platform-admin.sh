#!/bin/bash
set -euo pipefail
bash scripts/publish-website.sh
curl -fsSL https://toasty.media/admin/ | grep -Fq "People & access"
curl -fsSL https://toasty.media/js/platform-admin.js | grep -Fq "async function createMember"
