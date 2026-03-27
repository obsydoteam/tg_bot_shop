#!/usr/bin/env sh
set -eu

if [ ! -f ".env" ]; then
  echo "Missing .env file. Create it from .env.example first."
  exit 1
fi

docker compose up -d --build
echo "OBSYDO VPN bot deployed."
