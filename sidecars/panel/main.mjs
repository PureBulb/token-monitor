import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = join(APP_DATA_DIR, 'brain');

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

// Pages & Assets
app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

function findTranscriptFile(convId) {
  if (convId) {
    const p = join(BRAIN_DIR, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  if (existsSync(BRAIN_DIR)) {
    try {
      const dirs = readdirSync(BRAIN_DIR);
      let bestFile = null;
      let bestTime = 0;
      for (const d of dirs) {
        const candidate = join(BRAIN_DIR, d, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(candidate)) {
          const mtime = statSync(candidate).mtimeMs;
          if (mtime > bestTime) {
            bestTime = mtime;
            bestFile = candidate;
          }
        }
      }
      return bestFile;
    } catch (_) {}
  }
  return null;
}

function calculateContextBreakdown(steps, currentContext) {
  let toolChars = 0;
  let chatChars = 0;
  let systemChars = 0;
  let summaryChars = 0;
  const toolUsage = new Map();
  let lastToolNames = [];

  for (const s of steps) {
    const stype = s.type;
    const content = s.content || '';
    const tcalls = s.tool_calls || [];

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
    } else if (stype === 'PLANNER_RESPONSE') {
      chatChars += content.length;
    } else if (stype === 'USER_INPUT') {
      chatChars += content.length;
    } else if (stype === 'SYSTEM_MESSAGE' || stype === 'EPHEMERAL_MESSAGE') {
      if (content.includes('[ACP]') || content.includes('Compressed') || content.includes('billion-context')) {
        summaryChars += content.length;
      } else {
        systemChars += content.length;
      }
    } else {
      systemChars += content.length;
    }
  }

  const totalChars = toolChars + chatChars + systemChars + summaryChars || 1;
  const toolPct = ((toolChars / totalChars) * 100).toFixed(1);
  const chatPct = ((chatChars / totalChars) * 100).toFixed(1);
  const systemPct = ((systemChars / totalChars) * 100).toFixed(1);
  const summaryPct = ((summaryChars / totalChars) * 100).toFixed(1);

  const toolTokens = Math.round(currentContext * (toolChars / totalChars));
  const chatTokens = Math.round(currentContext * (chatChars / totalChars));
  const systemTokens = Math.round(currentContext * (systemChars / totalChars));
  const summaryTokens = Math.round(currentContext * (summaryChars / totalChars));

  const sortedTools = Array.from(toolUsage.entries()).sort((a, b) => b[1] - a[1]);
  const totalToolUsage = Array.from(toolUsage.values()).reduce((a, b) => a + b, 0) || 1;
  const topTools = sortedTools.slice(0, 3).map(([name, count]) => {
    const pct = Math.round((count / totalToolUsage) * 100);
    return `${name} ${pct}%`;
  }).join(' · ');

  return {
    toolPct: parseFloat(toolPct) || 0,
    chatPct: parseFloat(chatPct) || 0,
    systemPct: parseFloat(systemPct) || 0,
    summaryPct: parseFloat(summaryPct) || 0,
    toolTokens,
    chatTokens,
    systemTokens,
    summaryTokens,
    topTools,
  };
}

// API: Get live statistics
app.api('/api/stats', (query) => {
  const convId = query?.conversationId;
  const transcriptPath = findTranscriptFile(convId);

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      connected: false,
      message: '未找到会话日志数据',
      summary: null,
      steps: [],
    };
  }

  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const steps = [];
    for (const line of lines) {
      try {
        steps.push(JSON.parse(line));
      } catch (_) {}
    }

    const plannerSteps = steps.filter((s) => s.type === 'PLANNER_RESPONSE');
    if (plannerSteps.length === 0) {
      return {
        connected: true,
        transcriptPath,
        summary: {
          totalTokens: 0,
          totalInputTokens: 0,
          totalCacheTokens: 0,
          totalOutputTokens: 0,
          currentContext: 0,
          contextLimit: 1048576,
          contextUsagePct: '0.0%',
          latestHitRate: '0.0%',
          overallHitRate: '0.0%',
          latestSpeed: '-',
          averageSpeed: '-',
          stepCount: 0,
        },
        steps: [],
      };
    }

    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    let totalSpeedSum = 0;
    let validSpeedCount = 0;

    const formattedSteps = [];

    const stepMap = new Map();
    for (const st of steps) {
      if (st.step_index !== undefined) stepMap.set(st.step_index, st);
    }

    const measuredSpeeds = [];

    for (let i = 0; i < plannerSteps.length; i++) {
      const s = plannerSteps[i];
      const inTok = s.input_tokens || 0;
      const cacheTok = s.cache_read_tokens || 0;
      const outTok = s.output_tokens || 0;
      const turnTokens = inTok + cacheTok + outTok;
      const ctx = inTok + cacheTok;
      const hitRate = ctx > 0 ? ((cacheTok / ctx) * 100).toFixed(1) : '0.0';

      totalInput += inTok;
      totalCache += cacheTok;
      totalOutput += outTok;

      // Accurate speed: measure elapsed time between planner step and the subsequent tool step
      let stepSpeed = null;
      const next = stepMap.get(s.step_index + 1);
      if (next && next.created_at && (next.type === 'GENERIC' || next.type === 'TOOL_RESULT')) {
        const t1 = new Date(s.created_at).getTime();
        const t2 = new Date(next.created_at).getTime();
        const sec = (t2 - t1) / 1000;
        if (sec >= 1.0 && outTok > 0) {
          const sp = outTok / sec;
          if (sp >= 10 && sp <= 180) {
            stepSpeed = parseFloat(sp.toFixed(1));
            measuredSpeeds.push(stepSpeed);
          }
        }
      }

      formattedSteps.push({
        stepIndex: s.step_index,
        createdAt: s.created_at,
        inputTokens: inTok,
        cacheTokens: cacheTok,
        outputTokens: outTok,
        turnTokens,
        contextLength: ctx,
        hitRate: `${hitRate}%`,
        speed: stepSpeed ? `${stepSpeed} t/s` : (measuredSpeeds.length > 0 ? `~${(measuredSpeeds[measuredSpeeds.length - 1]).toFixed(1)} t/s` : '~38 t/s'),
      });
    }

    const avgSpeedVal = measuredSpeeds.length > 0
      ? (measuredSpeeds.reduce((a, b) => a + b, 0) / measuredSpeeds.length).toFixed(1)
      : '35.0';

    const recentSpeeds = measuredSpeeds.slice(-5);
    const recentSpeedVal = recentSpeeds.length > 0
      ? (recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length).toFixed(1)
      : avgSpeedVal;

    const latestSpeedStr = `~${recentSpeedVal} t/s`;
    const avgSpeedStr = `~${avgSpeedVal} t/s`;

    const last = formattedSteps[formattedSteps.length - 1];
    const grandTotal = totalInput + totalCache + totalOutput;
    const contextLimit = 1048576;
    const currentContext = last.contextLength;
    const contextUsagePct = ((currentContext / contextLimit) * 100).toFixed(1) + '%';
    const overallHitRate = (totalInput + totalCache) > 0
      ? (((totalCache) / (totalInput + totalCache)) * 100).toFixed(1) + '%'
      : '0.0%';

    const breakdown = calculateContextBreakdown(steps, currentContext);

    return {
      connected: true,
      transcriptPath,
      summary: {
        totalTokens: grandTotal,
        totalInputTokens: totalInput,
        totalCacheTokens: totalCache,
        totalOutputTokens: totalOutput,
        latestInput: last.inputTokens,
        latestCache: last.cacheTokens,
        latestOutput: last.outputTokens,
        currentContext,
        contextLimit,
        contextUsagePct,
        latestHitRate: last.hitRate,
        overallHitRate,
        latestSpeed: latestSpeedStr,
        averageSpeed: avgSpeedStr,
        stepCount: plannerSteps.length,
        breakdown,
      },
      steps: formattedSteps.slice(-15).reverse(), // Last 15 steps
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
    };
  }
}, 'GET');

app.run();
