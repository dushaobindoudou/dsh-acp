#!/usr/bin/env bash
# A complete ACP conversation over HTTP+SSE, using only curl (+ python3 for
# SSE frame parsing). Works against both HTTP transports:
#
#   ./curl-conversation.sh http://127.0.0.1:7800 [bearer-token]
#
#     - `dsh --profile acp serve --port 7800`          (standalone serve mode)
#     - `dsh web` (web-mounted: same paths on the GUI port, default 3080)
#
# What it does: initialize (capture Acp-Connection-Id) -> open the SSE
# stream -> session/new -> session/prompt (watch chunks stream in) ->
# session/close -> DELETE the connection. Exit code 0 = the whole
# conversation matched expectations.
set -euo pipefail

base="${1:-http://127.0.0.1:7800}"
token="${2:-}"
auth=()
[ -n "$token" ] && auth=(-H "authorization: Bearer $token")

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. initialize: 200 + JSON body + Acp-Connection-Id header ──────────────
say "initialize $base"
headers=$(mktemp) || die mktemp
body=$(curl -sS -D "$headers" ${auth[@]+"${auth[@]}"} -X POST "$base/acp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}') \
  || die "POST /acp unreachable"
connection=$(tr -d '\r' < "$headers" | awk 'tolower($1)=="acp-connection-id:" {print $2}')
[ -n "$connection" ] || die "no Acp-Connection-Id in response"
printf '%s\n  connection: %s\n' "$(printf '%s' "$body" | head -c 120)" "$connection"

# ── 2. SSE stream (server->client messages) in the background ──────────────
sse=$(mktemp) || die mktemp
curl -sN --max-time 300 ${auth[@]+"${auth[@]}"} "$base/acp/stream" -H "acp-connection-id: $connection" > "$sse" &
sse_pid=$!

post() { # post <method> <params> ; all non-initialize messages return 202
  curl -sS -o /dev/null -w '%{http_code}' ${auth[@]+"${auth[@]}"} -X POST "$base/acp" \
    -H "acp-connection-id: $connection" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$1,\"method\":\"$2\",\"params\":$3}"
}

# poll SSE until a response/field appears, then print the streamed text
# usage: wait_for <python-expr on frames> <timeout-seconds>
wait_for() {
  python3 - "$sse" "$1" "$2" <<'PYEOF'
import json, sys, time
path, want, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
deadline = time.time() + timeout
while time.time() < deadline:
    try:
        frames = [json.loads(l[6:]) for l in open(path) if l.startswith('data: ')]
    except FileNotFoundError:
        frames = []
    for f in frames:
        try:
            if eval(want, {}, {'f': f}):
                print(json.dumps(f, ensure_ascii=False)); sys.exit(0)
        except Exception:
            pass
    time.sleep(0.5)
sys.exit(1)
PYEOF
}

# ── 3. session/new ──────────────────────────────────────────────────────────
say 'session/new'
code=$(post 2 'session/new' "{\"cwd\":\"$PWD\",\"mcpServers\":[]}")
[ "$code" = 202 ] || die "session/new -> HTTP $code (expected 202)"
session=$(wait_for "f.get('id')==2 and 'result' in f" 60 \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["sessionId"])') \
  || die 'no sessionId on the SSE stream'
echo "  session: $session"

# ── 4. session/prompt (streaming) ───────────────────────────────────────────
say 'session/prompt - replying with one sentence'
code=$(post 3 'session/prompt' "{\"sessionId\":\"$session\",\"prompt\":[{\"type\":\"text\",\"text\":\"Reply with exactly one short sentence.\"}]}")
[ "$code" = 202 ] || die "session/prompt -> HTTP $code (expected 202)"
wait_for "f.get('id')==3 and 'result' in f" 240 >/dev/null || die 'no prompt result within 240s'

python3 - "$sse" "$session" <<'PYEOF'
import json, sys
path, session = sys.argv[1], sys.argv[2]
text, stop, kinds = '', None, set()
for line in open(path):
    if not line.startswith('data: '): continue
    m = json.loads(line[6:])
    if m.get('id') == 3: stop = m['result']['stopReason']
    else:
        u = m.get('params', {}).get('update', {})
        k = u.get('sessionUpdate')
        if k == 'agent_message_chunk' and m['params']['sessionId'] == session:
            text += u['content']['text']
        if k: kinds.add(k)
print('  streamed:', ', '.join(sorted(kinds)))
print('  stopReason:', stop)
print('  agent said:', ' '.join(text.split())[:200])
assert stop == 'end_turn', f'unexpected stopReason {stop!r}'
assert text.strip(), 'no message chunks arrived'
PYEOF
[ $? -eq 0 ] || die 'prompt assertions failed'

# ── 5. session/close + DELETE the connection ────────────────────────────────
say 'teardown'
post 4 'session/close' "{\"sessionId\":\"$session\"}" >/dev/null || true
code=$(curl -sS -o /dev/null -w '%{http_code}' ${auth[@]+"${auth[@]}"} -X DELETE "$base/acp" \
  -H "acp-connection-id: $connection")
[ "$code" = 204 ] || die "DELETE -> HTTP $code (expected 204)"
kill "$sse_pid" 2>/dev/null || true
rm -f "$headers" "$sse"
say 'OK - full conversation over HTTP+SSE'
