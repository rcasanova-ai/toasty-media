#!/bin/bash
set -e

IMAGE="$1"
NAME="$2"

if [ ! -f "$IMAGE" ]; then
  echo "Image not found: $IMAGE"
  exit 1
fi

mkdir -p site/assets/images/media

cp "$IMAGE" "site/assets/images/media/$NAME"

git add "site/assets/images/media/$NAME"
git commit -m "Upload article image: $NAME"
git push

echo "Image uploaded successfully."
