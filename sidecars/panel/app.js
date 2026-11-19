const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let currentPreviewMarkdown = '';
const VALID_MODELS = ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash'];
let savedModel = localStorage.getItem('tm_model');
let selectedModel = VALID_MODELS.includes(savedModel) ? savedModel : 'gemini-4-neon';

let fileFilterMode = 'all';
let fileSearchQuery = '';
let cmdFilterMode = 'all';
let cmdSearchQuery = '';
let cmdProgramFilter = null;

function formatNumber(num) {
  if (num === undefined || num === null || isNaN(num)) return '-';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function formatDuration(ms) {
  if (ms === undefined || ms === null) return '-';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return `${ms}ms`;
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2000);
}

// Tab Switching
function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-content').forEach((pane) => {
    pane.classList.toggle('active', pane.id === tabId);
  });
  if (tabId === 'tab-trend' && currentStatsData) {
    renderTrendChart(currentStatsData.trends, currentStatsData.summary?.trendStats);
  }
}

// Fetch Stats API
async function fetchStats() {
  const convId = sidecar?.conversationId || '';
  const url = `/api/stats?${convId ? 'conversationId=' + encodeURIComponent(convId) + '&' : ''}model=${encodeURIComponent(selectedModel)}`;

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
    currentStatsData = data;

    renderOverview(data.summary);
    renderBadges(data);
    if (activeTab === 'tab-trend') {
      renderTrendChart(data.trends, data.summary.trendStats);
    }
    renderFilesTab(data.files, data.summary.fileStats);
    renderCommandsTab(data.commands, data.summary.cmdStats);
    renderTurnsTab(data.steps);
  } catch (err) {
    $('status-badge').textContent = '断开';
    $('status-badge').className = 'badge err';
  }
}

// 1. Render Overview Tab
function renderOverview(s) {
  // Key Metrics
  $('val-total-tokens').textContent = formatNumber(s.totalTokens);
  $('val-sub-tokens').textContent = `入: ${formatNumber(s.latestInput)} · 缓: ${formatNumber(s.latestCache)} · 出: ${formatNumber(s.latestOutput)}`;

  $('val-speed').textContent = s.latestSpeed || '-';
  $('val-sub-speed').textContent = `平均: ${s.averageSpeed || '-'}`;

  $('val-hit-rate').textContent = s.overallHitRate || '0.0%';
  const overallPct = parseFloat(s.overallHitRate) || 0;
  $('bar-hit-rate').style.width = Math.min(Math.max(overallPct, 0), 100) + '%';
  $('val-sub-hit-rate').textContent = `当轮: ${s.latestHitRate || '0.0%'} (全会话省 ${formatNumber(s.totalCacheTokens)} tok)`;

  // Cost
  if (s.cost) {
    $('val-cost').textContent = `${s.cost.formattedUSD}`;
    $('val-sub-cost').textContent = `折合 ${s.cost.formattedCNY} · 缓存已省 ${s.cost.formattedSavingsUSD}`;
  }

  // Context & 6-Category Breakdown
  $('val-context').textContent = formatNumber(s.currentContext);
  $('val-sub-context').textContent = `(${s.contextUsagePct} / 1M)`;

  if (s.breakdown) {
    const b = s.breakdown;
    $('bar-ctx-tool').style.width = `${b.toolPct}%`;
    $('bar-ctx-system').style.width = `${b.systemPct}%`;
    $('bar-ctx-thinking').style.width = `${b.thinkingPct}%`;
    $('bar-ctx-assistant').style.width = `${b.assistantPct}%`;
    $('bar-ctx-user').style.width = `${b.userPct}%`;
    $('bar-ctx-summary').style.width = `${b.summaryPct}%`;

    $('chip-val-tool').textContent = `${formatNumber(b.toolTokens)} (${b.toolPct}%)`;
    $('chip-val-system').textContent = `${formatNumber(b.systemTokens)} (${b.systemPct}%)`;
    $('chip-val-thinking').textContent = `${formatNumber(b.thinkingTokens)} (${b.thinkingPct}%)`;
    $('chip-val-assistant').textContent = `${formatNumber(b.assistantTokens)} (${b.assistantPct}%)`;
    $('chip-val-user').textContent = `${formatNumber(b.userTokens)} (${b.userPct}%)`;
    $('chip-val-summary').textContent = `${formatNumber(b.summaryTokens)} (${b.summaryPct}%)`;

    $('val-top-tools').textContent = b.topTools || '暂无工具调用';
  }

  // Quick Audit Grid
  if (s.fileStats) {
    $('quick-files-total').textContent = s.fileStats.totalFiles;
    $('quick-files-sub').textContent = `读 ${s.fileStats.reads} · 写 ${s.fileStats.writes} · +${s.fileStats.linesAdded} / -${s.fileStats.linesDeleted} 行`;
  }
  if (s.cmdStats) {
    $('quick-cmd-total').textContent = s.cmdStats.totalCommands;
    $('quick-cmd-sub').textContent = `成功 ${s.cmdStats.successCount} · 错误 ${s.cmdStats.errorCount}`;
  }

  // Preview Box
  currentPreviewMarkdown = `> 📊 **实时统计** ｜ **消耗 Token**: \`${formatNumber(s.totalTokens)}\` (输入 \`${formatNumber(s.latestInput)}\` · 缓存 \`${formatNumber(s.latestCache)}\` · 输出 \`${formatNumber(s.latestOutput)}\`) ｜ **速度**: \`${s.latestSpeed}\` ｜ **缓存命中率**: \`均 ${s.overallHitRate} (当轮 ${s.latestHitRate})\` ｜ **费用**: \`${s.cost ? s.cost.formattedUSD : '-'}\` ｜ **上下文**: \`${(s.currentContext || 0).toLocaleString()} / 1,000,000\` (\`${s.contextUsagePct}\`)`;
  $('bottom-bar-preview').textContent = currentPreviewMarkdown;
}

// 2. Render Navigation Badges
function renderBadges(data) {
  if (data.summary?.trendStats?.totalDrops !== undefined) {
    $('trend-drops-badge').textContent = `${data.summary.trendStats.totalDrops} 📦`;
  }
  if (data.summary?.fileStats?.totalFiles !== undefined) {
    $('files-count-badge').textContent = String(data.summary.fileStats.totalFiles);
  }
  if (data.summary?.cmdStats?.totalCommands !== undefined) {
    $('commands-count-badge').textContent = String(data.summary.cmdStats.totalCommands);
  }
}

// 3. Render SVG Trend Chart
function renderTrendChart(trends, trendStats) {
  if (!trends || trends.length === 0) return;

  if (trendStats) {
    $('trend-peak-val').textContent = formatNumber(trendStats.peakContext);
    $('trend-min-val').textContent = formatNumber(trendStats.minContext);
    $('trend-drops-val').textContent = `${trendStats.totalDrops} 次`;
  }
  const lastTrend = trends[trends.length - 1];
  $('trend-current-val').textContent = formatNumber(lastTrend?.ctx || 0);

  const svg = $('trend-svg');
  const width = 500;
  const height = 180;
  const padLeft = 45;
  const padRight = 15;
  const padTop = 15;
  const padBottom = 25;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const maxVal = Math.max(...trends.map((t) => t.ctx), 10000) * 1.1;

  // Grid Lines & Y Labels
  let gridHtml = `
    <defs>
      <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#89b4fa" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#89b4fa" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
  `;

  const yTicks = [0, 0.33, 0.66, 1.0];
  yTicks.forEach((ratio) => {
    const val = maxVal * (1 - ratio);
    const y = padTop + chartH * ratio;
    gridHtml += `
      <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#313244" stroke-dasharray="3,3" stroke-width="1"/>
      <text x="${padLeft - 6}" y="${y + 3}" fill="#6c7086" font-size="9" text-anchor="end" font-family="monospace">${formatNumber(val)}</text>
    `;
  });

  // Calculate points
  const points = trends.map((t, i) => {
    const x = padLeft + (i / (trends.length - 1 || 1)) * chartW;
    const y = padTop + chartH * (1 - t.ctx / maxVal);
    return { x, y, trend: t, index: i };
  });

  const linePathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaPathD = `${linePathD} L ${points[points.length - 1].x.toFixed(1)} ${height - padBottom} L ${points[0].x.toFixed(1)} ${height - padBottom} Z`;

  let pathsHtml = `
    <path d="${areaPathD}" fill="url(#areaGradient)" />
    <path d="${linePathD}" fill="none" stroke="#89b4fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  `;

  // Draw drop points (scissors / box)
  let markersHtml = '';
  points.forEach((p) => {
    if (p.trend.isDrop) {
      markersHtml += `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#fab387" stroke="#11111b" stroke-width="1.5" />
        <text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" fill="#fab387" font-size="10" text-anchor="middle">📦</text>
      `;
    }
  });

  svg.innerHTML = gridHtml + pathsHtml + markersHtml;

  // Tooltip interaction
  const container = $('trend-chart-container');
  const tooltip = $('chart-tooltip');

  container.onmousemove = (e) => {
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const ratioX = Math.max(0, Math.min(1, (mouseX - (padLeft * rect.width / width)) / (chartW * rect.width / width)));
    const targetIdx = Math.round(ratioX * (trends.length - 1));
    const pt = points[targetIdx];
    if (!pt) return;

    const t = pt.trend;
    const deltaText = t.delta > 0 ? `+${formatNumber(t.delta)}` : (t.delta < 0 ? `-${formatNumber(Math.abs(t.delta))}` : '0');
    const timeStr = t.time ? new Date(t.time).toLocaleTimeString() : '';

    tooltip.style.display = 'block';
    tooltip.style.left = `${(pt.x * rect.width / width)}px`;
    tooltip.style.top = `${(pt.y * rect.height / height)}px`;
    tooltip.innerHTML = `
      <div style="font-weight:600;color:#89b4fa">轮次 #${t.step} <span style="font-size:9px;color:#a6adc8">${timeStr}</span></div>
      <div>上下文: <b>${formatNumber(t.ctx)}</b> Token</div>
      <div>增量: <span style="color:${t.delta < 0 ? '#fab387' : '#a6e3a1'}">${deltaText}</span></div>
      ${t.isDrop ? '<div style="color:#fab387;margin-top:2px">📦 发生历史压缩截断</div>' : ''}
    `;
  };

  container.onmouseleave = () => {
    tooltip.style.display = 'none';
  };
}

// 4. Render Files Tab
function renderFilesTab(files, stats) {
  if (stats) {
    $('files-stat-total').textContent = stats.totalFiles;
    $('files-stat-reads').textContent = stats.reads;
    $('files-stat-writes').textContent = stats.writes;
    $('files-stat-added').textContent = `+${stats.linesAdded}`;
    $('files-stat-deleted').textContent = `-${stats.linesDeleted}`;
  }

  if (!files || files.length === 0) {
    $('files-tbody').innerHTML = '<tr><td colspan="4" class="empty-state">暂无文件活动记录</td></tr>';
    return;
  }

  const query = fileSearchQuery.toLowerCase();
  const filtered = files.filter((f) => {
    if (fileFilterMode === 'writes' && f.writes === 0) return false;
    if (fileFilterMode === 'reads' && f.reads === 0) return false;
    if (query && !f.path.toLowerCase().includes(query)) return false;
    return true;
  });

  if (filtered.length === 0) {
    $('files-tbody').innerHTML = '<tr><td colspan="4" class="empty-state">没有匹配的文件</td></tr>';
    return;
  }

  $('files-tbody').innerHTML = filtered.map((f) => {
    const isWrite = f.writes > 0;
    const opTag = isWrite
      ? `<span class="tag-badge tag-write">改 ${f.writes}</span>`
      : `<span class="tag-badge tag-read">读 ${f.reads}</span>`;

    let deltaHtml = '<span style="color:var(--text-dim)">-</span>';
    if (f.linesAdded > 0 || f.linesDeleted > 0) {
      deltaHtml = `<span class="delta-added">+${f.linesAdded}</span> / <span class="delta-deleted">-${f.linesDeleted}</span>`;
    }

    return `
      <tr>
        <td>
          <div class="file-cell" title="${f.path}">
            <span class="file-basename">${f.basename}</span>
            <span class="file-dirpath">${f.path}</span>
          </div>
        </td>
        <td>${opTag}</td>
        <td>${deltaHtml}</td>
        <td><span class="badge">#${f.lastStep}</span></td>
      </tr>
    `;
  }).join('');
}

// 5. Render Commands Tab
function renderCommandsTab(commands, stats) {
  // Render program frequency chips
  if (stats && stats.topPrograms) {
    const wrap = $('prog-chips-wrap');
    wrap.innerHTML = stats.topPrograms.map((p) => {
      const activeClass = cmdProgramFilter === p.prog ? 'active' : '';
      return `<span class="prog-chip ${activeClass}" data-prog="${p.prog}">${p.prog} (${p.count})</span>`;
    }).join('');

    wrap.querySelectorAll('.prog-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const prog = chip.dataset.prog;
        cmdProgramFilter = (cmdProgramFilter === prog) ? null : prog;
        renderCommandsTab(commands, stats);
      });
    });
  }

  if (!commands || commands.length === 0) {
    $('cmd-tbody').innerHTML = '<tr><td colspan="5" class="empty-state">暂无命令执行记录</td></tr>';
    return;
  }

  const query = cmdSearchQuery.toLowerCase();
  const filtered = commands.filter((c) => {
    if (cmdFilterMode === 'success' && c.status !== 'SUCCESS') return false;
    if (cmdFilterMode === 'error' && c.status !== 'ERROR') return false;
    if (cmdProgramFilter && c.prog !== cmdProgramFilter) return false;
    if (query && !c.fullCmd.toLowerCase().includes(query)) return false;
    return true;
  });

  if (filtered.length === 0) {
    $('cmd-tbody').innerHTML = '<tr><td colspan="5" class="empty-state">没有匹配的命令记录</td></tr>';
    return;
  }

  $('cmd-tbody').innerHTML = filtered.map((c) => {
    const isOk = c.status === 'SUCCESS';
    const statusTag = isOk
      ? `<span class="tag-badge tag-ok">OK</span>`
      : `<span class="tag-badge tag-err">ERR ${c.exitCode}</span>`;

    return `
      <tr>
        <td>${statusTag}</td>
        <td><span class="badge" style="font-family:monospace">${c.prog}</span></td>
        <td><div class="code-cell" title="${c.fullCmd}">${c.cmd}</div></td>
        <td><span style="color:var(--text-dim);font-family:monospace">${formatDuration(c.durationMs)}</span></td>
        <td><span class="badge">#${c.step}</span></td>
      </tr>
    `;
  }).join('');
}

// 6. Render Turns Tab
function renderTurnsTab(steps) {
  const tbody = $('history-tbody');
  if (steps && steps.length > 0) {
    tbody.innerHTML = steps.map((st) => `
      <tr>
        <td>#${st.stepIndex}</td>
        <td><b>${formatNumber(st.turnTokens)}</b></td>
        <td>${formatNumber(st.inputTokens)} / ${formatNumber(st.cacheTokens)} / ${formatNumber(st.outputTokens)}</td>
        <td><span style="color:#a6e3a1">${st.hitRate}</span></td>
        <td>${st.speed}</td>
      </tr>
    `).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">暂无轮次记录</td></tr>';
  }
}

function init() {
  // Restore model selector
  $('model-select').value = selectedModel;
  $('model-select').addEventListener('change', (e) => {
    selectedModel = e.target.value;
    localStorage.setItem('tm_model', selectedModel);
    fetchStats();
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Quick navigation buttons from overview
  $('btn-goto-files')?.addEventListener('click', () => switchTab('tab-files'));
  $('btn-goto-commands')?.addEventListener('click', () => switchTab('tab-commands'));

  // Refresh & Copy
  $('btn-refresh').addEventListener('click', () => {
    window.location.reload();
  });
  $('btn-copy').addEventListener('click', () => {
    if (!currentPreviewMarkdown) return;
    navigator.clipboard.writeText(currentPreviewMarkdown).then(() => {
      showToast('已复制 Markdown 底栏到剪贴板！');
    });
  });

  // Files search & filters
  $('files-search').addEventListener('input', (e) => {
    fileSearchQuery = e.target.value;
    if (currentStatsData) renderFilesTab(currentStatsData.files, currentStatsData.summary?.fileStats);
  });
  document.querySelectorAll('[data-file-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-file-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      fileFilterMode = btn.dataset.fileFilter;
      if (currentStatsData) renderFilesTab(currentStatsData.files, currentStatsData.summary?.fileStats);
    });
  });

  // Commands search & filters
  $('cmd-search').addEventListener('input', (e) => {
    cmdSearchQuery = e.target.value;
    if (currentStatsData) renderCommandsTab(currentStatsData.commands, currentStatsData.summary?.cmdStats);
  });
  document.querySelectorAll('[data-cmd-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-cmd-filter]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      cmdFilterMode = btn.dataset.cmdFilter;
      if (currentStatsData) renderCommandsTab(currentStatsData.commands, currentStatsData.summary?.cmdStats);
    });
  });

  fetchStats();
  setInterval(fetchStats, 2500);
}

init();
