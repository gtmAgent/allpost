/**
 * 任务组分发：
 * - 文案（==sep== 分隔）、图片、视频均可选；至少一类非空
 * - 每条文案 / 每张图片 / 每个视频各生成 1 条任务
 * - 轮询均分到所选浏览器（有多的就平均发布）
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayEndSec,
  localDayStartSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

/** 文案分隔符：单条可含换行，多条用 ==sep== 隔开。 */
const CONTENT_SEP = '==sep==';

function splitContentsBySep(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return text
    .split(CONTENT_SEP)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

type PostUnit = {
  content: string;
  image: string;
  video: string;
};

function rollBrowserToNextDay(baseSec: number, st: PerBrowserScheduleState, dayStartMin: number): void {
  st.dayOffset += 1;
  st.usedInDay = 0;
  st.cursorSec = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
}

function prepareSlotForCurrentTask(
  baseSec: number,
  st: PerBrowserScheduleState,
  dailyLimit: number,
  duringMin: number,
  dayStartMin: number,
  dayEndMin: number,
): void {
  const maxDayRolls = 366;
  let dayRolls = 0;
  for (;;) {
    const dayStart = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
    const dayEnd = localDayEndSec(baseSec, st.dayOffset, dayEndMin);
    if (st.cursorSec < dayStart) st.cursorSec = dayStart;
    const exceedsDayEnd = st.cursorSec > dayEnd || st.cursorSec + duringMin > dayEnd;
    if (st.usedInDay >= dailyLimit || exceedsDayEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check daily_limit / during_min / time window)');
      }
      rollBrowserToNextDay(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
}

function buildPostUnits(groupConfig: TaskGroupConfig): PostUnit[] {
  const contents = splitContentsBySep(groupConfig.contents);
  const images = normalizeResources(groupConfig.images);
  const videos = normalizeResources(groupConfig.videos);
  const units: PostUnit[] = [];
  for (const content of contents) {
    units.push({ content, image: '', video: '' });
  }
  for (const image of images) {
    units.push({ content: '', image, video: '' });
  }
  for (const video of videos) {
    units.push({ content: '', image: '', video });
  }
  return units;
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const units = buildPostUnits(groupConfig);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);

  if (units.length === 0) {
    return {
      succ: false,
      msg: 'no content: provide at least one caption (==sep==), image, or video',
    };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const perBrowserCounts = new Map<number, number>();
  const tasks: TaskCreateInput[] = [];

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const browserId = browserIds[i % browserIds.length]!;
    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ??
      ({
        dayOffset: 0,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
      } satisfies PerBrowserScheduleState);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config: {
        content: unit.content,
        image: unit.image || null,
        video: unit.video || null,
      },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);
    perBrowserSchedule.set(browserId, st);
    perBrowserCounts.set(browserId, (perBrowserCounts.get(browserId) ?? 0) + 1);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / contents / browsers)' };
  }

  const countSummary = browserIds
    .map((id) => `browser ${id}=${perBrowserCounts.get(id) ?? 0}`)
    .join(', ');
  const kindSummary = `units=${units.length} (caption/image/video each → 1 task), even round-robin → ${browserIds.length} browsers`;

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (${kindSummary}); ${countSummary}`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
