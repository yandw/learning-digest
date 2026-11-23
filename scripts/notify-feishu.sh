#!/usr/bin/env bash
# notify-feishu.sh — 通过飞书群自定义机器人发送通知。
# 本文件由 Kimi 维护（Kimi-managed）；Canonical 正本位于：
#   ~/.kimi/daimon/skills/feishu-notify/scripts/notify-feishu.sh
# 两处实现一致，改通知格式/换密钥请改正本，再同步本副本。
#
# 用法:
#   scripts/notify-feishu.sh "标题" "正文" ["链接文字" "链接URL"]
#
# 配置: scripts/feishu-notify.env（gitignored，勿提交真实密钥）
#   FEISHU_WEBHOOK  机器人 webhook 地址（必填）
#   FEISHU_SECRET   安全设置里开启「签名校验」后的密钥（可选）
#
# 退出码: 0 发送成功（飞书返回 code=0）；1 发送失败。
# 调用方应 best-effort 使用（`|| true` 或捕获后仅告警），
# 通知失败不应阻断主任务。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/feishu-notify.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

: "${FEISHU_WEBHOOK:?FEISHU_WEBHOOK 未配置，请检查 $ENV_FILE}"
FEISHU_SECRET="${FEISHU_SECRET:-}"

TITLE="${1:?用法: notify-feishu.sh <标题> <正文> [链接文字 链接URL]}"
BODY="${2:-}"
LINK_TEXT="${3:-}"
LINK_URL="${4:-}"

# 用 python3 做签名（HMAC-SHA256）、JSON 构造与 HTTP 提交，
# 避免 bash 手写 JSON 的转义坑。macOS 自带 python3。
TITLE="$TITLE" BODY="$BODY" LINK_TEXT="$LINK_TEXT" LINK_URL="$LINK_URL" \
FEISHU_WEBHOOK="$FEISHU_WEBHOOK" FEISHU_SECRET="$FEISHU_SECRET" \
python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.request

webhook = os.environ["FEISHU_WEBHOOK"]
secret = os.environ.get("FEISHU_SECRET", "")
title = os.environ["TITLE"]
body = os.environ.get("BODY", "")
link_text = os.environ.get("LINK_TEXT", "")
link_url = os.environ.get("LINK_URL", "")

content = []
if body:
    for line in body.splitlines():
        content.append([{"tag": "text", "text": line}])
if link_text and link_url:
    content.append([{"tag": "a", "text": link_text, "href": link_url}])

payload = {
    "msg_type": "post",
    "content": {"post": {"zh_cn": {"title": title, "content": content}}},
}

if secret:
    timestamp = str(int(time.time()))
    string_to_sign = f"{timestamp}\n{secret}"
    # 飞书官方约定：stringToSign = timestamp\nsecret 作为 HMAC 密钥，消息为空。
    sign = base64.b64encode(
        hmac.new(
            string_to_sign.encode("utf-8"),
            b"",
            hashlib.sha256,
        ).digest()
    ).decode("utf-8")
    payload["timestamp"] = timestamp
    payload["sign"] = sign

req = urllib.request.Request(
    webhook,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read().decode("utf-8"))
except Exception as exc:
    print(f"[notify-feishu] 请求失败: {exc}", file=sys.stderr)
    sys.exit(1)

# 飞书 webhook v2 成功返回 {"code": 0, "msg": "success"}
if result.get("code") != 0:
    print(f"[notify-feishu] 飞书返回错误: {result}", file=sys.stderr)
    sys.exit(1)

print("[notify-feishu] 已发送 ✓")
PY
