#!/usr/bin/env node

/**
 * Token & Performance Tracker Hook for Antigravity
 * - Accurate speed calculation (elapsed time between planner step and tool step)
 * - Transparent cache hit rate reporting (both current turn & cumulative hit rate)
 * - Real-time cost estimation ($ USD / ¥ CNY) with cache savings
 * - 6-category Context breakdown (Tools, System, Thinking, Assistant, User, Summaries)
 * - Sleek Generative UI capsule widget automatically injected into conversation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRICING_PROFILES = {
  'gemini-4-neon': {
    name: 'Gemini 4 Neon (主力编码)',
    inputPerM: 3.00,
    cachePerM: 0.15, // 95% discount on repeated context
    outputPerM: 15.00,
  },
  'gemini-4-carbon': {
    name: 'Gemini 4 Carbon (深度推理)',
    inputPerM: 2.00,
    cachePerM: 0.10,
    outputPerM: 10.00,
  },
  'gemini-4-argon': {
    name: 'Gemini 4 Argon (长程推理)',
    inputPerM: 2.00,
    cachePerM: 0.10,
    outputPerM: 10.00,
  },
  'gemini-4-hydrogen': {
    name: 'Gemini 4 Hydrogen (日常极速)',
    inputPerM: 1.50,
    cachePerM: 0.075,
    outputPerM: 7.50,
  },
  'gemini-3.8-flash': {
    name: 'Gemini 3.8 Flash (轻量极速)',
    inputPerM: 0.75,
    cachePerM: 0.075,
    outputPerM: 3.75,
  },
};
const USD_TO_CNY = 7.25;

function formatK(num) {
  if (num === undefined || num === null || isNaN(num)) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function formatCost(usd) {
  if (usd === undefined || usd === null || isNaN(usd)) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function resolveTranscriptPath(input) {
  if (input.transcriptPath && fs.existsSync(input.transcriptPath)) {
    return input.transcriptPath;
  }
  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
  const brainDir = path.join(appDataDir, 'brain');

  if (input.conversationId) {
    const candidate = path.join(brainDir, input.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }

  if (fs.existsSync(brainDir)) {
    try {
      const dirs = fs.readdirSync(brainDir);
      let bestFile = null;
      let bestTime = 0;
      for (const d of dirs) {
        const candidate = path.join(brainDir, d, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.mtimeMs > bestTime) {
            bestTime = stat.mtimeMs;
            bestFile = candidate;
          }
        }
      }
      if (bestFile) return bestFile;
    } catch (_) {}
  }
  return null;
}

function calculateContextBreakdown6(steps, currentContext) {
  let toolChars = 0;
  let userChars = 0;
  let thinkingChars = 0;
  let assistantChars = 0;
  let systemChars = 0;
  let summaryChars = 0;
  const toolUsage = new Map();
  let lastToolNames = [];

  for (const s of steps) {
    const stype = s.type;
    const content = s.content || '';
    const tcalls = s.tool_calls || [];

    if (s.thinking) {
      thinkingChars += s.thinking.length;
    }

    if (tcalls.length > 0) {
      lastToolNames = tcalls.map((tc) => tc.name).filter(Boolean);
      for (const tc of tcalls) {
        const tname = tc.name || 'unknown';
        const argLen = tc.args ? JSON.stringify(tc.args).length : 0;
        toolUsage.set(tname, (toolUsage.get(tname) || 0) + argLen);
        toolChars += argLen;
      }
    }

    if (stype === 'GENERIC' || stype === 'TOOL_RESULT') {
      const primaryTool = lastToolNames.length > 0 ? lastToolNames[0] : 'other';
      const len = content.length;
      toolUsage.set(primaryTool, (toolUsage.get(primaryTool) || 0) + len);
      toolChars += len;
    } else if (stype === 'USER_INPUT') {
      userChars += content.length;
    } else if (stype === 'PLANNER_RESPONSE') {
      assistantChars += content.length;
    } else if (stype === 'SYSTEM_MESSAGE' || stype === 'EPHEMERAL_MESSAGE') {
      if (content.includes('[ACP]') || content.includes('Compressed') || content.includes('billion-context') || content.includes('CONTEXT_SUMMARY')) {
        summaryChars += content.length;
      } else {
        systemChars += content.length;
      }
    } else {
      systemChars += content.length;
    }
  }

  const totalChars = toolChars + userChars + thinkingChars + assistantChars + systemChars + summaryChars || 1;

  const toolPct = ((toolChars / totalChars) * 100).toFixed(1);
  const userPct = ((userChars / totalChars) * 100).toFixed(1);
  const thinkingPct = ((thinkingChars / totalChars) * 100).toFixed(1);
  const assistantPct = ((assistantChars / totalChars) * 100).toFixed(1);
  const systemPct = ((systemChars / totalChars) * 100).toFixed(1);
  const summaryPct = ((summaryChars / totalChars) * 100).toFixed(1);

  const toolTokens = Math.round(currentContext * (toolChars / totalChars));
  const userTokens = Math.round(currentContext * (userChars / totalChars));
  const thinkingTokens = Math.round(currentContext * (thinkingChars / totalChars));
  const assistantTokens = Math.round(currentContext * (assistantChars / totalChars));
  const systemTokens = Math.round(currentContext * (systemChars / totalChars));
  const summaryTokens = Math.round(currentContext * (summaryChars / totalChars));

  // Top tools
  const sortedTools = Array.from(toolUsage.entries()).sort((a, b) => b[1] - a[1]);
  const totalToolUsage = Array.from(toolUsage.values()).reduce((a, b) => a + b, 0) || 1;
  const topTools = sortedTools.slice(0, 3).map(([name, count]) => {
    const pct = Math.round((count / totalToolUsage) * 100);
    return `${name} ${pct}%`;
  }).join(' · ');

  // Multi-line tooltip text
  const tooltipLines = [
    `📏 上下文 6 维构成分类 (当前 ${formatK(currentContext)} Token / 1M 窗口):`,
    `─────────────────────────────────`,
    `🔧 工具与执行输出: ${formatK(toolTokens)} (${toolPct}%)`,
  ];
  if (topTools) {
    tooltipLines.push(`   └─ 主要工具: ${topTools}`);
  }
  tooltipLines.push(`⚙️ 系统提示与规则: ${formatK(systemTokens)} (${systemPct}%)`);
  if (thinkingTokens > 0) {
    tooltipLines.push(`🧠 深度思考与推理: ${formatK(thinkingTokens)} (${thinkingPct}%)`);
  }
  tooltipLines.push(`🤖 模型回答输出: ${formatK(assistantTokens)} (${assistantPct}%)`);
  tooltipLines.push(`👤 用户输入与指令: ${formatK(userTokens)} (${userPct}%)`);
  if (summaryTokens > 0) {
    tooltipLines.push(`📦 历史压缩摘要: ${formatK(summaryTokens)} (${summaryPct}%)`);
  }
  tooltipLines.push(`─────────────────────────────────`);
  tooltipLines.push(`💡 上下文主要由${parseFloat(toolPct) > 50 ? '工具调用与执行输出' : '模型思考与系统规则'}构成`);

  return {
    toolPct: parseFloat(toolPct) || 0,
    userPct: parseFloat(userPct) || 0,
    thinkingPct: parseFloat(thinkingPct) || 0,
    assistantPct: parseFloat(assistantPct) || 0,
    systemPct: parseFloat(systemPct) || 0,
    summaryPct: parseFloat(summaryPct) || 0,
    toolTokens,
    userTokens,
    thinkingTokens,
    assistantTokens,
    systemTokens,
    summaryTokens,
    topTools,
    tooltipText: tooltipLines.join('\n'),
  };
}

function calculateCost(totalInput, totalCache, totalOutput, profileKey = 'gemini-1.5-pro') {
  const profile = PRICING_PROFILES[profileKey] || PRICING_PROFILES['gemini-1.5-pro'];
  const inCost = (totalInput / 1000000) * profile.inputPerM;
  const cacheCost = (totalCache / 1000000) * profile.cachePerM;
  const outCost = (totalOutput / 1000000) * profile.outputPerM;
  const totalUSD = inCost + cacheCost + outCost;
  const totalCNY = totalUSD * USD_TO_CNY;
  const cacheSavingsUSD = (totalCache / 1000000) * (profile.inputPerM - profile.cachePerM);
  const cacheSavingsCNY = cacheSavingsUSD * USD_TO_CNY;

  return {
    modelName: profile.name,
    totalUSD,
    totalCNY,
    cacheSavingsUSD,
    cacheSavingsCNY,
    formattedUSD: formatCost(totalUSD),
    formattedCNY: `¥${totalCNY.toFixed(2)}`,
    formattedSavingsUSD: formatCost(cacheSavingsUSD),
    formattedSavingsCNY: `¥${cacheSavingsCNY.toFixed(2)}`,
  };
}

function generateCapsuleHtml(stats) {
  const isHealthyCache = stats.overallHitRateNum >= 30 || stats.lastCache > 0;
  const dotColorClass = isHealthyCache ? 'bg-emerald-500' : 'bg-amber-500';
  const dotPingClass = isHealthyCache ? 'bg-emerald-400 opacity-75' : 'bg-amber-400 opacity-75';
  const cacheTextColor = isHealthyCache ? 'text-emerald-400' : 'text-amber-400';

  const costTip = `预估费用: ${stats.cost.formattedUSD} (≈ ${stats.cost.formattedCNY}) | 缓存节省: ${stats.cost.formattedSavingsUSD} | 计费基准: ${stats.cost.modelName}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
</head>
<body class="bg-transparent text-[var(--foreground)] antialiased p-1 m-0 select-none">
  <div class="bg-[var(--card)]/90 backdrop-blur-md border border-[var(--border)] rounded-xl p-2.5 shadow-sm flex flex-wrap items-center justify-between gap-2 text-xs">
    <!-- Left: Status pill with pulsing dot & Cost estimate -->
    <div class="flex items-center gap-2">
      <span class="flex h-2 w-2 relative">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full ${dotPingClass}"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 ${dotColorClass}"></span>
      </span>
      <span class="font-semibold text-[var(--foreground)] tracking-wide">实时统计</span>
      <span class="text-[var(--muted-foreground)] text-[11px]">|</span>
      <span class="text-[var(--muted-foreground)]">消耗:</span>
      <span class="font-mono font-medium text-[var(--foreground)]">${stats.totalFormatted}</span>
      <span class="text-[var(--muted-foreground)] text-[10px] hidden sm:inline">(入${stats.inputFormatted} · 缓${stats.cacheFormatted} · 出${stats.outputFormatted})</span>

      <!-- Cost badge with tooltip -->
      <div class="flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded px-1.5 py-0.5 cursor-pointer font-mono text-[11px]" title="${costTip}">
        <span>💰</span>
        <span>${stats.cost.formattedUSD}</span>
      </div>
    </div>

    <!-- Right metrics: Speed, Cache Hit %, Context 6-Bar -->
    <div class="flex items-center gap-3">
      <!-- Speed -->
      <div class="flex items-center gap-1 bg-[var(--background)]/60 border border-[var(--border)] rounded-md px-2 py-0.5" title="模型生成速率 (近期平均)">
        <span class="text-amber-400">⚡</span>
        <span class="font-mono">${stats.speedStr}</span>
      </div>

      <!-- Cache hit rate (Average prioritized) -->
      <div class="flex items-center gap-1 bg-[var(--background)]/60 border border-[var(--border)] rounded-md px-2 py-0.5" title="Prompt 缓存命中率: 会话累计平均 ${stats.overallHitRate}% | 当轮最新: ${stats.lastHitRate}% (累计节省 ${stats.totalCacheFormatted} Token / ${stats.cost.formattedSavingsUSD})">
        <span class="${cacheTextColor}">🎯</span>
        <span class="font-mono ${cacheTextColor} font-medium">均 ${stats.overallHitRate}%</span>
        <span class="text-[var(--muted-foreground)] text-[10px] hidden sm:inline">(当轮 ${stats.lastHitRate}%)</span>
      </div>

      <!-- Context window with 6-Breakdown Tips -->
      <div class="flex flex-col gap-0.5 bg-[var(--background)]/60 border border-[var(--border)] rounded-md px-2 py-0.5 cursor-pointer hover:border-sky-500/50 transition-colors" title="${stats.breakdown ? stats.breakdown.tooltipText : '当前上下文长度与窗口占用'}">
        <div class="flex items-center gap-1">
          <span class="text-sky-400">📏</span>
          <span class="font-mono text-[var(--foreground)]">${stats.currentContextFormatted}</span>
          <span class="text-[var(--muted-foreground)] text-[10px]">(${stats.contextPct})</span>
        </div>
        ${stats.breakdown ? `
        <!-- 6-category breakdown bar -->
        <div class="w-full h-1 rounded-full overflow-hidden flex bg-[var(--border)]/40 mt-0.5" style="min-width: 65px;">
          <div style="width: ${stats.breakdown.toolPct}%" class="bg-purple-500 h-full" title="工具与执行 ${stats.breakdown.toolPct}%"></div>
          <div style="width: ${stats.breakdown.systemPct}%" class="bg-blue-500 h-full" title="系统规则 ${stats.breakdown.systemPct}%"></div>
          <div style="width: ${stats.breakdown.thinkingPct}%" class="bg-indigo-400 h-full" title="思考推理 ${stats.breakdown.thinkingPct}%"></div>
          <div style="width: ${stats.breakdown.assistantPct}%" class="bg-teal-400 h-full" title="模型回答 ${stats.breakdown.assistantPct}%"></div>
          <div style="width: ${stats.breakdown.userPct}%" class="bg-emerald-500 h-full" title="用户输入 ${stats.breakdown.userPct}%"></div>
          <div style="width: ${stats.breakdown.summaryPct}%" class="bg-amber-500 h-full" title="压缩摘要 ${stats.breakdown.summaryPct}%"></div>
        </div>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  let stdinBuffer = '';
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    stdinBuffer += chunk;
  }

  let input = {};
  try {
    if (stdinBuffer.trim()) {
      input = JSON.parse(stdinBuffer);
    }
  } catch (_) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  try {
    const transcriptPath = resolveTranscriptPath(input);
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const steps = [];
    for (const l of lines) {
      try { steps.push(JSON.parse(l)); } catch (_) {}
    }

    const plannerSteps = steps.filter((s) => s.type === 'PLANNER_RESPONSE');
    if (plannerSteps.length === 0) {
      process.stdout.write(JSON.stringify({}));
      return;
    }

    const stepMap = new Map();
    for (const s of steps) {
      if (s.step_index !== undefined) stepMap.set(s.step_index, s);
    }

    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    const measuredSpeeds = [];

    for (const s of plannerSteps) {
      const inT = s.input_tokens || 0;
      const cT = s.cache_read_tokens || 0;
      const outT = s.output_tokens || 0;
      totalInput += inT;
      totalCache += cT;
      totalOutput += outT;

      const next = stepMap.get(s.step_index + 1);
      if (next && next.created_at && (next.type === 'GENERIC' || next.type === 'TOOL_RESULT')) {
        const t1 = new Date(s.created_at).getTime();
        const t2 = new Date(next.created_at).getTime();
        const sec = (t2 - t1) / 1000;
        if (sec >= 1.0 && outT > 0) {
          const sp = outT / sec;
          if (sp >= 10 && sp <= 180) {
            measuredSpeeds.push(sp);
          }
        }
      }
    }

    const grandTotal = totalInput + totalCache + totalOutput;
    const last = plannerSteps[plannerSteps.length - 1];
    const lastInput = last.input_tokens || 0;
    const lastCache = last.cache_read_tokens || 0;
    const lastOutput = last.output_tokens || 0;

    const currentContext = lastInput + lastCache;
    const lastHitRate = currentContext > 0 ? ((lastCache / currentContext) * 100).toFixed(1) : '0.0';
    const overallHitRate = (totalInput + totalCache) > 0 ? ((totalCache / (totalInput + totalCache)) * 100).toFixed(1) : '0.0';

    let speedValue = 48.0;
    if (measuredSpeeds.length > 0) {
      const recent = measuredSpeeds.slice(-5);
      speedValue = recent.reduce((a, b) => a + b, 0) / recent.length;
    }
    const speedStr = `~${speedValue.toFixed(1)} t/s`;

    const contextLimit = 1048576;
    const contextPct = ((currentContext / contextLimit) * 100).toFixed(1) + '%';

    const breakdown = calculateContextBreakdown6(steps, currentContext);
    const cost = calculateCost(totalInput, totalCache, totalOutput, 'gemini-4-neon');

    const statsObj = {
      totalFormatted: formatK(grandTotal),
      inputFormatted: formatK(lastInput),
      cacheFormatted: formatK(lastCache),
      outputFormatted: formatK(lastOutput),
      totalCacheFormatted: formatK(totalCache),
      lastCache,
      speedStr,
      lastHitRate,
      overallHitRate,
      overallHitRateNum: parseFloat(overallHitRate) || 0,
      currentContextFormatted: formatK(currentContext),
      contextPct,
      breakdown,
      cost,
    };

    let artifactDir = input.artifactDirectoryPath;
    if (!artifactDir && input.conversationId) {
      const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
      artifactDir = path.join(appDataDir, 'brain', input.conversationId);
    }

    let capsulePath = null;
    if (artifactDir && fs.existsSync(artifactDir)) {
      capsulePath = path.join(artifactDir, 'token_capsule.html');
      try {
        fs.writeFileSync(capsulePath, generateCapsuleHtml(statsObj), 'utf8');
      } catch (_) {}
    }

    const injectPayload = {
      injectSteps: [
        {
          ephemeralMessage: `[TOKEN_MONITOR_STATS]\n[CAPSULE_PATH]: ${capsulePath || ''}\n[INSTRUCTION]: 用户要求使用 Generative UI 胶囊卡片展示底栏。请在回答最末尾直接附带且仅附带胶囊微件：\n<agent-embed src="file://${capsulePath}"></agent-embed>\n无需再输出任何 Markdown 文本底栏。`,
        },
      ],
    };

    process.stdout.write(JSON.stringify(injectPayload));
  } catch (_) {
    process.stdout.write(JSON.stringify({}));
  }
}

main();
