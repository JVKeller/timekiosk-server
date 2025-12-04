#!/usr/bin/env bash
# Usage: ./setup-certbot.sh <domain>
# This script obtains a Let's Encrypt certificate using Certbot in standalone mode.
# It requires sudo privileges to bind to port 80.

if [ -z "$1" ]; then
  echo "Domain argument required"
  exit 1
fi
DOMAIN=$1

# Install certbot if not present (Debian/Ubuntu example)
if ! command -v certbot >/dev/null 2>&1; then
  echo "Installing certbot..."
  sudo apt-get update && sudo apt-get install -y certbot
fi

# Obtain certificate
sudo certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos -m admin@$DOMAIN

if [ $? -eq 0 ]; then
  echo "Certificate obtained successfully."
else
  echo "Failed to obtain certificate."
  exit 1
fi
