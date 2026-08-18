#!/usr/bin/env bash
# Regenerate torn-trade-desk.pda.user.js — the minified build for Torn PDA (mobile).
# PDA's webview won't execute the full 226KB readable script (though size isn't the cause;
# minifying is what makes it run). Run this after editing torn-trade-desk.user.js, then commit both.
set -e
cd "$(dirname "$0")"
SRC=torn-trade-desk.user.js
OUT=torn-trade-desk.pda.user.js
TMP="$(mktemp).js"
VER=$(grep -m1 -oE '@version[[:space:]]+[0-9.]+' "$SRC" | grep -oE '[0-9.]+' | head -1)

npx --yes esbuild "$SRC" --minify --target=es2017 --legal-comments=none --outfile="$TMP"

cat > "$OUT" <<HDR
// ==UserScript==
// @name         Torn Trade Desk (PDA)
// @namespace    tekim.tradedesk
// @version      $VER
// @updateURL    https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.pda.user.js
// @downloadURL  https://raw.githubusercontent.com/traskmi/torn-trade-desk/main/torn-trade-desk.pda.user.js
// @description  Torn Trade Desk — minified build for Torn PDA (mobile). Auto-generated from torn-trade-desk.user.js by build-pda.sh; do not edit by hand.
// @author       Tekim
// @match        https://www.torn.com/*
// @match        *://*.torn.com/*
// @connect      yata.yt
// @connect      api.torn.com
// @connect      weav3r.dev
// @connect      raw.githubusercontent.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==
HDR
cat "$TMP" >> "$OUT"
rm -f "$TMP"
# PDA's GM_info.script.version is undefined → inject the real version into the __TDK_VER__ fallback.
sed -i "s/__TDK_VER__/$VER/g" "$OUT"
node --check "$OUT" && echo "Built $OUT v$VER ($(wc -c < "$OUT") bytes)"
