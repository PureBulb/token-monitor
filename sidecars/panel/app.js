const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let currentPreviewMarkdown = '';

function formatNumber(num) {
  if (num === undefined || num === null) return '-';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2000);
}

async function fetchStats() {
  const convId = sidecar?.conversationId || '';
  const url = `/api/stats${convId ? '?conversationId=' + encodeURIComponent(convId) : ''}`;

  try {
    const res = await (sidecar ? sidecar.fetch(url) : fetch(url));
    const data = await res.json();

    if (!data || !data.connected || !data.summary) {
      $('status-badge').textContent = '等待会话';
      $('status-badge').className = 'badge';
      return;
    }

    $('status-badge').textContent = '实时同步中';
    $('status-badge').className = 'badge ok';

    const s = data.summary;

    // 1. 消耗 Token
    $('val-total-tokens').textContent = formatNumber(s.totalTokens);
    $('val-sub-tokens').textContent = `入: ${formatNumber(s.latestInput)} · 缓: ${formatNumber(s.latestCache)} · 出: ${formatNumber(s.latestOutput)}`;

    // 2. Token 速度
    $('val-speed').textContent = s.latestSpeed || '-';
    $('val-sub-speed').textContent = `平均: ${s.averageSpeed || '-'}`;

    // 3. 缓存命中率 (优先展示全会话平均)
    $('val-hit-rate').textContent = s.overallHitRate || '0.0%';
    const overallPct = parseFloat(s.overallHitRate) || 0;
    $('bar-hit-rate').style.width = Math.min(Math.max(overallPct, 0), 100) + '%';
    $('val-sub-hit-rate').textContent = `最新当轮: ${s.latestHitRate || '0.0%'} (缓存 ${formatNumber(s.latestCache)} Token)`;

    // 4. 上下文长度与构成 Tips
    $('val-context').textContent = formatNumber(s.currentContext);
    const ctxPct = parseFloat(s.contextUsagePct) || 0;
    $('val-sub-context').textContent = `${(s.currentContext || 0).toLocaleString()} / 1M (${s.contextUsagePct})`;

    if (s.breakdown) {
      const b = s.breakdown;
      $('bar-ctx-tool').style.width = b.toolPct + '%';
      $('bar-ctx-system').style.width = b.systemPct + '%';
      $('bar-ctx-chat').style.width = b.chatPct + '%';
      $('bar-ctx-summary').style.width = b.summaryPct + '%';

      const tipsBox = $('ctx-breakdown-tips');
      tipsBox.style.display = 'block';
      tipsBox.innerHTML = `
        <div class="breakdown-row">
          <span class="breakdown-label"><span class="dot-tag" style="background:#cba6f7"></span>工具与执行</span>
          <span>${formatNumber(b.toolTokens)} (${b.toolPct}%)</span>
        </div>
        ${b.topTools ? `<div style="padding-left:10px;margin-bottom:3px;color:var(--muted-foreground);font-size:9px">└─ ${b.topTools}</div>` : ''}
        <div class="breakdown-row">
          <span class="breakdown-label"><span class="dot-tag" style="background:#89b4fa"></span>系统与环境</span>
          <span>${formatNumber(b.systemTokens)} (${b.systemPct}%)</span>
        </div>
        <div class="breakdown-row">
          <span class="breakdown-label"><span class="dot-tag" style="background:#a6e3a1"></span>对话问答</span>
          <span>${formatNumber(b.chatTokens)} (${b.chatPct}%)</span>
        </div>
        ${b.summaryTokens > 0 ? `
        <div class="breakdown-row">
          <span class="breakdown-label"><span class="dot-tag" style="background:#f9e2af"></span>压缩摘要</span>
          <span>${formatNumber(b.summaryTokens)} (${b.summaryPct}%)</span>
        </div>` : ''}
      `;
    }

    // Preview
    currentPreviewMarkdown = `> 📊 **实时统计** ｜ **消耗 Token**: \`${formatNumber(s.totalTokens)}\` (输入 \`${formatNumber(s.latestInput)}\` · 缓存 \`${formatNumber(s.latestCache)}\` · 输出 \`${formatNumber(s.latestOutput)}\`) ｜ **速度**: \`${s.latestSpeed}\` ｜ **缓存命中率**: \`${s.latestHitRate}\` ｜ **上下文长度**: \`${(s.currentContext || 0).toLocaleString()} / 1,000,000\` (\`${s.contextUsagePct}\`)`;
    $('bottom-bar-preview').textContent = currentPreviewMarkdown;

    // History Table
    const tbody = $('history-tbody');
    if (data.steps && data.steps.length > 0) {
      tbody.innerHTML = data.steps.map((st) => `
        <tr>
          <td>#${st.stepIndex}</td>
          <td><b>${formatNumber(st.turnTokens)}</b></td>
          <td>${formatNumber(st.inputTokens)} / ${formatNumber(st.cacheTokens)} / ${formatNumber(st.outputTokens)}</td>
          <td><span style="color:#a6e3a1">${st.hitRate}</span></td>
          <td>${st.speed}</td>
        </tr>
      `).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted-foreground)">暂无轮次记录</td></tr>';
    }
  } catch (err) {
    $('status-badge').textContent = '断开';
    $('status-badge').className = 'badge err';
  }
}

function init() {
  $('btn-refresh').addEventListener('click', fetchStats);

  $('btn-copy').addEventListener('click', () => {
    if (!currentPreviewMarkdown) return;
    navigator.clipboard.writeText(currentPreviewMarkdown).then(() => {
      showToast('已复制 Markdown 底栏到剪贴板！');
    });
  });

  fetchStats();
  setInterval(fetchStats, 2000);
}

init();
