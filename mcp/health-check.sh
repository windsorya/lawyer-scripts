#!/bin/bash
# MCP 服務健康監控 + 自動重啟
# 建立：2026-04-11
# 觸發：每 30 分鐘由 launchd 執行（com.lawyer.mcp-health-check）
#
# 監控對象（共 4 個，CC 跳過）：
#   aceofbase.ngrok.app   → 判決 DB MCP  (port 8000)
#   drive-mcp.ngrok.app   → Drive MCP    (port 3100)
#   wjv-ai-proxy.ngrok.app→ AI Proxy     (port 3200)
#   lawyer-maps.ngrok.app → Maps MCP     (port 8002)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLAGS_DIR="$SCRIPT_DIR/flags"
LAUNCHD_UID=$(id -u)
DATE_STR=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
LOG_FILE="$SCRIPT_DIR/health-check-${DATE_STR}.log"

mkdir -p "$FLAGS_DIR"

# ─── 清理 7 天前的 log ─────────────────────────────────────────
find "$SCRIPT_DIR" -name "health-check-*.log" -mtime +7 -delete 2>/dev/null

# ─── log 函式 ──────────────────────────────────────────────────
log() {
    echo "[${TIMESTAMP}] $1" | tee -a "$LOG_FILE"
}

# ─── 健康檢查：GET /sse，回傳 0=活著, 1=掛了 ─────────────────
check_endpoint() {
    local url="$1"
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time 10 --connect-timeout 5 \
        -H "Accept: text/event-stream" \
        "$url" 2>/dev/null)
    case "$code" in
        200|201|202|400|405|406|426)
            return 0
            ;;
        *)
            log "    HTTP 回應碼: $code"
            return 1
            ;;
    esac
}

# ─── 重啟 launchd 服務 ────────────────────────────────────────
restart_launchd() {
    local label="$1"
    log "  → launchctl kickstart -k gui/${LAUNCHD_UID}/${label}"
    launchctl kickstart -k "gui/${LAUNCHD_UID}/${label}" >> "$LOG_FILE" 2>&1
}

# ─── 監控單一服務（含 2 次重啟重試）──────────────────────────
# 用法：monitor_service <顯示名稱> <url> <server_label> <ngrok_label>
monitor_service() {
    local name="$1"
    local url="$2"
    local server_label="$3"
    local ngrok_label="$4"
    local flag_file="$FLAGS_DIR/${server_label}_failed.flag"

    log ""
    log "【$name】$url"

    if check_endpoint "$url"; then
        log "  ✅ 正常"
        rm -f "$flag_file"
        return 0
    fi

    log "  ❌ 異常 — 開始重啟流程"

    # 第 1 次重啟：先重啟 server，再重啟 ngrok
    restart_launchd "$server_label"
    sleep 8
    restart_launchd "$ngrok_label"
    sleep 20

    if check_endpoint "$url"; then
        log "  ✅ 第 1 次重啟後恢復正常"
        rm -f "$flag_file"
        return 0
    fi

    log "  ⚠️  第 1 次重啟後仍異常，再試一次..."

    # 第 2 次重啟
    restart_launchd "$server_label"
    sleep 10
    restart_launchd "$ngrok_label"
    sleep 25

    if check_endpoint "$url"; then
        log "  ✅ 第 2 次重啟後恢復正常"
        rm -f "$flag_file"
        return 0
    fi

    # 兩次重啟仍失敗 → 寫 flag 讓晨報撿
    log "  🔴 重啟 2 次後仍異常 — 寫入 flag 等待人工介入"
    echo "FAILED at ${TIMESTAMP}" > "$flag_file"
    return 1
}

# ═══════════════════════════════════════════════════════════════
log "=========================================="
log "MCP 健康監控啟動"
log "=========================================="

# 1. 判決 DB MCP
monitor_service \
    "判決 DB MCP" \
    "https://aceofbase.ngrok.app/sse" \
    "com.judicial.mcp-server" \
    "com.judicial.ngrok"

# 2. claude-code.ngrok.app → CC 自管，跳過
log ""
log "【CC MCP】claude-code.ngrok.app — ⏭️ 跳過（CC 自管）"

# 3. Google Drive MCP
monitor_service \
    "Google Drive MCP" \
    "https://drive-mcp.ngrok.app/sse" \
    "com.drive-mcp.server" \
    "com.drive-mcp.ngrok"

# 4. AI Proxy
monitor_service \
    "AI Proxy" \
    "https://wjv-ai-proxy.ngrok.app/sse" \
    "com.ai-proxy.server" \
    "com.ai-proxy.ngrok"

# 5. Google Maps MCP
monitor_service \
    "Google Maps MCP" \
    "https://lawyer-maps.ngrok.app/sse" \
    "com.lawyer.google-maps-mcp" \
    "com.lawyer.google-maps-ngrok"

log ""
log "=========================================="
log "健康監控完成"
log "=========================================="
