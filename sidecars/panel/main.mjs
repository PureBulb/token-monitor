import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(os.homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = join(APP_DATA_DIR, 'brain');

const PRICING_PROFILES = {
  'gemini-1.5-pro': {
    name: 'Gemini 1.5 Pro',
    inputPerM: 3.50,
    cachePerM: 0.875,
    outputPerM: 10.50,
  },
  'gemini-1.5-flash': {
    name: 'Gemini 1.5 Flash',
    inputPerM: 0.075,
    cachePerM: 0.01875,
    outputPerM: 0.30,
  },
  'gemini-2.0-flash': {
    name: 'Gemini 2.0 Flash',
    inputPerM: 0.10,
    cachePerM: 0.025,
    outputPerM: 0.40,
  },
  'claude-3-5-sonnet': {
    name: 'Claude 3.5 Sonnet',
    inputPerM: 3.00,
    cachePerM: 0.30,
    outputPerM: 15.00,
  },
};
const USD_TO_CNY = 7.25;

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
    modelKey: profileKey,
    modelName: profile.name,
    totalUSD,
    totalCNY,
    cacheSavingsUSD,
    cacheSavingsCNY,
    formattedUSD: totalUSD < 0.01 ? `$${totalUSD.toFixed(4)}` : `$${totalUSD.toFixed(2)}`,
    formattedCNY: `¥${totalCNY.toFixed(2)}`,
    formattedSavingsUSD: cacheSavingsUSD < 0.01 ? `$${cacheSavingsUSD.toFixed(4)}` : `$${cacheSavingsUSD.toFixed(2)}`,
    formattedSavingsCNY: `¥${cacheSavingsCNY.toFixed(2)}`,
  };
}

function analyzeTranscript(steps, plannerSteps) {
  let toolChars = 0;
  let userChars = 0;
  let thinkingChars = 0;
  let assistantChars = 0;
  let systemChars = 0;
  let summaryChars = 0;

  const toolUsage = new Map();
  const fileMap = new Map();
  const commands = [];
  const progCounts = new Map();
  let lastToolNames = [];

  const stepMap = new Map();
  for (const s of steps) {
    if (s.step_index !== undefined) stepMap.set(s.step_index, s);
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
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

        // Command Activity
        if (tname === 'run_command') {
          const cmd = tc.args?.CommandLine || '';
          const cwd = tc.args?.Cwd || '';
          let prog = (cmd.trim().split(/\s+/)[0] || 'cmd').replace(/^["']|["']$/g, '');
          if (prog.includes('/')) prog = prog.split('/').pop();
          progCounts.set(prog, (progCounts.get(prog) || 0) + 1);

          // Find execution result in subsequent steps
          let exitCode = 0;
          let status = 'SUCCESS';
          let durationMs = null;
          const next = stepMap.get(s.step_index + 1) || (i + 1 < steps.length ? steps[i + 1] : null);
          if (next && (next.type === 'GENERIC' || next.type === 'TOOL_RESULT')) {
            const nextContent = next.content || '';
            const codeMatch = nextContent.match(/exited with code (\d+)/);
            if (codeMatch) {
              exitCode = parseInt(codeMatch[1], 10);
              status = exitCode === 0 ? 'SUCCESS' : 'ERROR';
            } else if (next.status === 'ERROR') {
              status = 'ERROR';
              exitCode = 1;
            } else if (next.status === 'DONE') {
              status = 'SUCCESS';
            }
            if (s.created_at && next.created_at) {
              durationMs = Math.max(0, new Date(next.created_at).getTime() - new Date(s.created_at).getTime());
            }
          }

          commands.push({
            step: s.step_index,
            prog,
            cmd: cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd,
            fullCmd: cmd,
            cwd,
            status,
            exitCode,
            durationMs,
            time: s.created_at,
          });
        }

        // File Activity: view_file
        if (tname === 'view_file') {
          const p = tc.args?.AbsolutePath;
          if (p) {
            const rec = fileMap.get(p) || {
              path: p,
              basename: basename(p),
              reads: 0,
              writes: 0,
              linesAdded: 0,
              linesDeleted: 0,
              lastStep: s.step_index,
            };
            rec.reads++;
            rec.lastStep = s.step_index;
            fileMap.set(p, rec);
          }
        }

        // File Activity: write_to_file
        if (tname === 'write_to_file') {
          const p = tc.args?.TargetFile;
          if (p) {
            const rec = fileMap.get(p) || {
              path: p,
              basename: basename(p),
              reads: 0,
              writes: 0,
              linesAdded: 0,
              linesDeleted: 0,
              lastStep: s.step_index,
            };
            rec.writes++;
            rec.lastStep = s.step_index;
            const code = tc.args?.CodeContent || '';
            rec.linesAdded += code.split('\n').length;
            fileMap.set(p, rec);
          }
        }

        // File Activity: replace_file_content
        if (tname === 'replace_file_content') {
          const p = tc.args?.TargetFile;
          if (p) {
            const rec = fileMap.get(p) || {
              path: p,
              basename: basename(p),
              reads: 0,
              writes: 0,
              linesAdded: 0,
              linesDeleted: 0,
              lastStep: s.step_index,
            };
            rec.writes++;
            rec.lastStep = s.step_index;
            const targetLines = (tc.args?.TargetContent || '').split('\n').length;
            const replLines = (tc.args?.ReplacementContent || '').split('\n').length;
            rec.linesDeleted += targetLines;
            rec.linesAdded += replLines;
            fileMap.set(p, rec);
          }
        }
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

  // File aggregation
  const files = Array.from(fileMap.values()).sort((a, b) => (b.writes + b.reads) - (a.writes + a.reads));
  const fileStats = {
    totalFiles: files.length,
    reads: files.reduce((acc, f) => acc + f.reads, 0),
    writes: files.reduce((acc, f) => acc + f.writes, 0),
    linesAdded: files.reduce((acc, f) => acc + f.linesAdded, 0),
    linesDeleted: files.reduce((acc, f) => acc + f.linesDeleted, 0),
  };

  // Command aggregation
  const sortedProgs = Array.from(progCounts.entries()).sort((a, b) => b[1] - a[1]);
  const cmdStats = {
    totalCommands: commands.length,
    successCount: commands.filter((c) => c.status === 'SUCCESS').length,
    errorCount: commands.filter((c) => c.status === 'ERROR').length,
    topPrograms: sortedProgs.slice(0, 6).map(([prog, count]) => ({ prog, count })),
  };

  // Top tools
  const sortedTools = Array.from(toolUsage.entries()).sort((a, b) => b[1] - a[1]);
  const totalToolUsage = Array.from(toolUsage.values()).reduce((a, b) => a + b, 0) || 1;
  const topTools = sortedTools.slice(0, 3).map(([name, count]) => {
    const pct = Math.round((count / totalToolUsage) * 100);
    return `${name} ${pct}%`;
  }).join(' · ');

  return {
    chars: { toolChars, userChars, thinkingChars, assistantChars, systemChars, summaryChars },
    topTools,
    files,
    fileStats,
    commands: commands.reverse(), // latest commands first
    cmdStats,
  };
}

// API: Get live statistics and full dsh-context feature suite
app.api('/api/stats', (query) => {
  const convId = query?.conversationId;
  const modelKey = query?.model || 'gemini-1.5-pro';
  const transcriptPath = findTranscriptFile(convId);

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return {
      connected: false,
      message: '未找到会话日志数据',
      summary: null,
      trends: [],
      files: [],
      commands: [],
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
        summary: null,
        trends: [],
        files: [],
        commands: [],
        steps: [],
      };
    }

    const stepMap = new Map();
    for (const st of steps) {
      if (st.step_index !== undefined) stepMap.set(st.step_index, st);
    }

    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    const measuredSpeeds = [];
    const formattedSteps = [];
    const trends = [];

    let prevContext = 0;
    let totalDrops = 0;

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

      // Speed measurement
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

      // Context trend & drops
      const delta = prevContext > 0 ? (ctx - prevContext) : 0;
      const isDrop = delta < -2000;
      if (isDrop) totalDrops++;

      trends.push({
        step: s.step_index,
        ctx,
        inTok,
        cacheTok,
        outTok,
        delta,
        isDrop,
        dropAmount: isDrop ? Math.abs(delta) : 0,
        time: s.created_at,
      });

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

      prevContext = ctx;
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

    // Comprehensive audit analysis
    const analysis = analyzeTranscript(steps, plannerSteps);
    const cost = calculateCost(totalInput, totalCache, totalOutput, modelKey);

    // 6-category context breakdown
    const chars = analysis.chars;
    const totalChars = chars.toolChars + chars.userChars + chars.thinkingChars + chars.assistantChars + chars.systemChars + chars.summaryChars || 1;

    const breakdown = {
      toolPct: parseFloat(((chars.toolChars / totalChars) * 100).toFixed(1)) || 0,
      userPct: parseFloat(((chars.userChars / totalChars) * 100).toFixed(1)) || 0,
      thinkingPct: parseFloat(((chars.thinkingChars / totalChars) * 100).toFixed(1)) || 0,
      assistantPct: parseFloat(((chars.assistantChars / totalChars) * 100).toFixed(1)) || 0,
      systemPct: parseFloat(((chars.systemChars / totalChars) * 100).toFixed(1)) || 0,
      summaryPct: parseFloat(((chars.summaryChars / totalChars) * 100).toFixed(1)) || 0,
      toolTokens: Math.round(currentContext * (chars.toolChars / totalChars)),
      userTokens: Math.round(currentContext * (chars.userChars / totalChars)),
      thinkingTokens: Math.round(currentContext * (chars.thinkingChars / totalChars)),
      assistantTokens: Math.round(currentContext * (chars.assistantChars / totalChars)),
      systemTokens: Math.round(currentContext * (chars.systemChars / totalChars)),
      summaryTokens: Math.round(currentContext * (chars.summaryChars / totalChars)),
      topTools: analysis.topTools,
    };

    const ctxValues = trends.map((t) => t.ctx);
    const trendStats = {
      peakContext: Math.max(...ctxValues, 0),
      minContext: Math.min(...ctxValues, 0),
      avgContext: Math.round(ctxValues.reduce((a, b) => a + b, 0) / (ctxValues.length || 1)),
      totalDrops,
      totalSteps: trends.length,
    };

    return {
      connected: true,
      transcriptPath,
      availableModels: Object.entries(PRICING_PROFILES).map(([k, v]) => ({ key: k, name: v.name })),
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
        cost,
        breakdown,
        fileStats: analysis.fileStats,
        cmdStats: analysis.cmdStats,
        trendStats,
      },
      trends, // All step trend points
      files: analysis.files, // Tracked files
      commands: analysis.commands.slice(0, 100), // Latest 100 commands
      steps: formattedSteps.slice(-25).reverse(), // Last 25 planner steps
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
    };
  }
}, 'GET');

app.run();
