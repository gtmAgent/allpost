/**
 * 任务组分发：
 * - 先选 media_type：image | video
 * - even_distribute=1（默认）：文案轮询均分到浏览器（任务数 = 文案数）
 * - even_distribute=0：每台浏览器独立把全部文案发一遍（任务数 = 文案数 × 浏览器数）
 * - 图片：池循环，每帖 image_count 张
 * - 视频：池循环，每帖固定 1 个
 * - 文案用 ==sep== 分隔（单条内可换行）；没有分隔符时整段算一条
 * - 日窗口支持跨天：daily_time_start > daily_time_end（如 22:00→06:00）按本机本地时区解释
 */
import type { TaskGroupConfig } from './config.types';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayStartSec,
  localDayTimeSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  type TaskCreateInput,
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

type PerBrowserScheduleState = {
  /** 窗口起始所在日历日相对 baseSec 本地日的偏移；跨天时可从 -1 起（昨日开始的一夜窗口）。 */
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

function isOvernightWindow(dayStartMin: number, dayEndMin: number): boolean {
  return dayStartMin > dayEndMin;
}

/** 日窗口长度（分钟）。同日：end-start；跨天：(1440-start)+end。 */
function dayWindowMinutes(dayStartMin: number, dayEndMin: number): number {
  if (dayStartMin === dayEndMin) return 0;
  if (dayStartMin < dayEndMin) return dayEndMin - dayStartMin;
  return 1440 - dayStartMin + dayEndMin;
}

function windowBoundsSec(
  baseSec: number,
  dayOffset: number,
  dayStartMin: number,
  dayEndMin: number,
): { start: number; end: number } {
  const start = localDayTimeSec(baseSec, dayOffset, dayStartMin);
  const end = isOvernightWindow(dayStartMin, dayEndMin)
    ? localDayTimeSec(baseSec, dayOffset + 1, dayEndMin)
    : localDayTimeSec(baseSec, dayOffset, dayEndMin);
  return { start, end };
}

/** 允许跨天的频率校验（替代 SDK validateTaskGroupScheduleConfig 的「开始必须早于结束」限制）。 */
function validateScheduleAllowOvernight(cfg: TaskGroupConfig): string[] {
  const errors: string[] = [];
  const duringMin = parsePositiveIntConfig(cfg.during_min, 60);
  const duringMax = parsePositiveIntConfig(cfg.during_max, 600);
  const dayStartMin = parseTimeToMinutes(cfg.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(cfg.daily_time_end, '18:00');

  if (dayStartMin === dayEndMin) {
    errors.push('daily_time_start and daily_time_end must differ (use start>end for overnight window)');
    return errors;
  }
  if (duringMin > duringMax) {
    errors.push('during_min must not be greater than during_max');
  }

  const windowSec = dayWindowMinutes(dayStartMin, dayEndMin) * 60;
  if (duringMin > windowSec) {
    errors.push(`during_min (${duringMin}s) exceeds daily execution window (${windowSec}s)`);
  }
  if (duringMax > windowSec) {
    errors.push(`during_max (${duringMax}s) exceeds daily execution window (${windowSec}s)`);
  }
  return errors;
}

function initialScheduleState(
  nowSec: number,
  dayStartMin: number,
  dayEndMin: number,
): PerBrowserScheduleState {
  if (isOvernightWindow(dayStartMin, dayEndMin)) {
    // 当前是否落在「昨日起 → 今日止」的跨天窗口内
    const prev = windowBoundsSec(nowSec, -1, dayStartMin, dayEndMin);
    if (nowSec <= prev.end) {
      return {
        dayOffset: -1,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, prev.start),
      };
    }
  }

  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    const { start, end } = windowBoundsSec(nowSec, dayOffset, dayStartMin, dayEndMin);
    if (nowSec > end) continue;
    return {
      dayOffset,
      usedInDay: 0,
      cursorSec: Math.max(nowSec, start),
    };
  }

  return {
    dayOffset: 0,
    usedInDay: 0,
    cursorSec: localDayStartSec(nowSec, 0, dayStartMin),
  };
}

function rollBrowserToNextWindow(
  baseSec: number,
  st: PerBrowserScheduleState,
  dayStartMin: number,
): void {
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
    const { start, end } = windowBoundsSec(baseSec, st.dayOffset, dayStartMin, dayEndMin);
    if (st.cursorSec < start) st.cursorSec = start;
    const exceedsWindowEnd = st.cursorSec > end || st.cursorSec + duringMin > end;
    if (st.usedInDay >= dailyLimit || exceedsWindowEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check daily_limit / during_min / time window)');
      }
      rollBrowserToNextWindow(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
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

function takeCycling(pool: string[], cursor: number, count: number): { items: string[]; next: number } {
  const items: string[] = [];
  let c = cursor;
  for (let j = 0; j < count; j++) {
    items.push(pool[c % pool.length]!);
    c += 1;
  }
  return { items, next: c };
}

type PostAssignment = {
  browserId: number;
  content: string;
  mediaCursor: number;
};

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const mediaType = groupConfig.media_type === 'video' ? 'video' : 'image';
  const contents = splitContentsBySep(groupConfig.contents);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const evenDistribute = Number(groupConfig.even_distribute) !== 0;

  if (contents.length === 0) {
    return { succ: false, msg: 'no captions in group config (contents)' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }

  const imagePool = normalizeResources(groupConfig.images);
  const videoPool = normalizeResources(groupConfig.videos);
  const imagesPerPost = parsePositiveIntConfig(groupConfig.image_count ?? 2, 2);

  if (mediaType === 'image') {
    if (imagePool.length === 0) {
      return { succ: false, msg: 'no images selected (media_type=image)' };
    }
    if (imagesPerPost < 1) {
      return { succ: false, msg: 'image_count must be at least 1' };
    }
  } else if (videoPool.length === 0) {
    return { succ: false, msg: 'no videos selected (media_type=video)' };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateScheduleAllowOvernight(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];
  const perBrowserCounts = new Map<number, number>();
  const overnight = isOvernightWindow(dayStartMin, dayEndMin);

  // 先展开「帖子→浏览器」分配；媒体游标按分配顺序连续推进
  const assignments: PostAssignment[] = [];
  if (evenDistribute) {
    // 文案轮询均分：任务数 = 文案数；第 i 帖 → 浏览器 i % N
    for (let i = 0; i < contents.length; i++) {
      assignments.push({
        browserId: browserIds[i % browserIds.length]!,
        content: contents[i]!,
        mediaCursor: i * (mediaType === 'image' ? imagesPerPost : 1),
      });
    }
  } else {
    // 笛卡尔积：每台浏览器各自从头循环媒体池
    for (const browserId of browserIds) {
      for (let i = 0; i < contents.length; i++) {
        assignments.push({
          browserId,
          content: contents[i]!,
          mediaCursor: i * (mediaType === 'image' ? imagesPerPost : 1),
        });
      }
    }
  }

  for (const asg of assignments) {
    const { browserId, content, mediaCursor } = asg;

    let config: Record<string, unknown>;
    if (mediaType === 'image') {
      const taken = takeCycling(imagePool, mediaCursor, imagesPerPost);
      config = { media_type: 'image', content, images: taken.items };
    } else {
      const taken = takeCycling(videoPool, mediaCursor, 1);
      config = { media_type: 'video', content, video: taken.items[0]! };
    }

    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ?? initialScheduleState(nowSec, dayStartMin, dayEndMin);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config,
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
  const mediaSummary =
    mediaType === 'image'
      ? `image×${imagesPerPost} from pool ${imagePool.length}`
      : `video×1 from pool ${videoPool.length}`;
  const windowSummary = overnight
    ? `overnight ${groupConfig.daily_time_start}→${groupConfig.daily_time_end}`
    : `same-day ${groupConfig.daily_time_start}–${groupConfig.daily_time_end}`;
  const modeSummary = evenDistribute
    ? `even distribute: ${contents.length} captions → ${browserIds.length} browsers`
    : `full list each: ${contents.length} captions × ${browserIds.length} browsers`;

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (${modeSummary}, ${mediaSummary}, cycling; ${windowSummary}); ${countSummary}`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
