#!/usr/bin/env bash
# Computes the 11-character Android SMS Retriever "app hash" for OTP_ANDROID_APP_HASH.
#
# The hash is sha256("<package> <signing certificate hex>") -> first 9 bytes -> base64 (11 chars), so it is
# different for every package name AND every signing certificate (debug key, upload key, Play app-signing key).
#
# Usage:
#   scripts/app-hash.sh <package> keystore <file.jks> <alias> [storepass]
#   scripts/app-hash.sh <package> cert <certificate.pem|.der|.crt>
#
# Examples:
#   scripts/app-hash.sh com.zenjigo.riders      keystore ../../ZenjiGORiders/android/upload-keystore.jks upload
#   scripts/app-hash.sh online.zenjigo.driver   keystore ../../zenjigodriver/android/driver-upload-keystore.jks driverupload
#   # Google Play App Signing: Play Console > Your app > Test and release > App integrity > App signing >
#   # "Download certificate" (.der), then:
#   scripts/app-hash.sh com.zenjigo.riders      cert deployment_cert.der
#   # Debug builds:
#   scripts/app-hash.sh com.zenjigo.riders      keystore ~/.android/debug.keystore androiddebugkey android
set -euo pipefail

if [ $# -lt 3 ]; then sed -n '2,19p' "$0"; exit 1; fi
PKG="$1"; MODE="$2"; shift 2
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

case "$MODE" in
  keystore)
    KS="$1"; ALIAS="$2"; PASS="${3:-}"
    if [ -n "$PASS" ]; then keytool -exportcert -alias "$ALIAS" -keystore "$KS" -storepass "$PASS" > "$TMP"
    else keytool -exportcert -alias "$ALIAS" -keystore "$KS" > "$TMP"; fi ;;
  cert)
    # Accept PEM or DER.
    if head -c 10 "$1" | grep -q -- '-----BEGIN'; then openssl x509 -in "$1" -outform DER > "$TMP"
    else cp "$1" "$TMP"; fi ;;
  *) echo "Mode must be 'keystore' or 'cert'"; exit 1 ;;
esac

HEX="$(xxd -p "$TMP" | tr -d '[:space:]')"
printf '%s %s' "$PKG" "$HEX" | sha256sum | cut -d' ' -f1 | xxd -r -p | head -c 9 | base64 | cut -c1-11
