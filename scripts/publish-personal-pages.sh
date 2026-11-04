#!/usr/bin/env bash
set -euo pipefail
: "${SSH_HOST:?Missing deploy host}"
: "${SSH_PORT:?Missing deploy port}"
: "${SSH_USER:?Missing deploy user}"
: "${SSH_PRIVATE_KEY:?Missing deploy key}"
install -m 700 -d ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/toasty_pages_key
chmod 600 ~/.ssh/toasty_pages_key
ssh-keyscan -p "$SSH_PORT" -H "$SSH_HOST" >> ~/.ssh/known_hosts
git archive --format=tar HEAD -- resume contact about ponderings speaking | ssh -i ~/.ssh/toasty_pages_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" 'cd /home/fmxgijyvpq/toasty.media && tar -xf -'
for route in resume contact about ponderings speaking; do
  curl --fail --location --retry 3 --retry-delay 3 --silent --show-error "https://toasty.media/$route/" -o "/tmp/$route.html"
  grep -qi '<html' "/tmp/$route.html"
done
grep -q 'contactForm' /tmp/contact.html
grep -q 'Download original resume' /tmp/resume.html
