#!/bin/sh
set -eu
url="$1"; out="$2"
admin=$(sed -n 's/^ADMIN_KEY=//p' .dev.vars)
[ -n "$admin" ] || { echo "no ADMIN_KEY in .dev.vars" >&2; exit 1; }
curl -sf "$url/" -o /dev/null || { echo "no office server at $url: run npm run dev" >&2; exit 1; }
curl -sf -X POST "$url/api/offices" -H "Authorization: Bearer $admin" \
  -H 'content-type: application/json' -d '{"name":"firegoat eval"}' > "$out/office.json"
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).joinKey)' "$out/office.json" > "$out/office-key.txt"
