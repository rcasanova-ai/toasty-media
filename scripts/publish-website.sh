#!/usr/bin/env bash
set -euo pipefail
: "${SSH_HOST:?Missing Spaceship SSH host}"
: "${SSH_PORT:?Missing Spaceship SSH port}"
: "${SSH_USER:?Missing Spaceship SSH user}"
: "${SSH_PRIVATE_KEY:?Missing Spaceship private key}"
install -m 700 -d ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/toasty_website_key
chmod 600 ~/.ssh/toasty_website_key
ssh-keyscan -p "$SSH_PORT" -H "$SSH_HOST" >> ~/.ssh/known_hosts
root=/home/fmxgijyvpq/toasty.media
# Only public website files, never Peeps, Studio or their backends.
paths=(index.html .htaccess sitemap.xml robots.txt about resume contact speaking ponderings articles css/toasty-site.css js/site-ui.js js/wisp-research.js js/ga4-public.js)
git archive --format=tar HEAD -- "${paths[@]}" | ssh -i ~/.ssh/toasty_website_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "cd '$root' && tar -xf -"
ssh -i ~/.ssh/toasty_website_key -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "test -s '$root/sitemap.xml' && test -s '$root/resume/index.html' && test -s '$root/contact/index.html'"
for route in sitemap.xml resume/ contact/ about/ speaking/ ponderings/ robots.txt; do
  curl --fail --silent --show-error --retry 5 --retry-delay 3 "https://toasty.media/$route" -o /tmp/toasty-check
done
curl --silent --show-error -I 'https://www.toasty.media/sitemap.xml' -o /tmp/toasty-www-headers
grep -Eqi '^location: https://toasty.media/sitemap.xml' /tmp/toasty-www-headers
echo "Website files deployed and canonical URLs validated."
