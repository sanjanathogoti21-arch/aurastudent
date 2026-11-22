#!/usr/bin/env bash
# Copies the web app into native/www so Capacitor can bundle it inside the APK.
set -e
cd "$(dirname "$0")"
rm -rf www && mkdir www
for f in index.html manifest.webmanifest sw.js icon-192.png icon-512.png badge-96.png; do cp "../$f" www/; done
echo "web app copied to native/www"
