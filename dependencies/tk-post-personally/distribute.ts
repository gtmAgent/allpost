/**
 * 任务组分发：
 * - media_type：image | video
 * - even_distribute=1（默认）：文案轮询均分到浏览器（任务数 = 文案数）→「平均分配」
 * - even_distribute=0：每台浏览器各自发全部文案（任务数 = 文案数 × 浏览器数）→「全部发布」
 * - 图片：池循环，每帖 image_count 张；视频：池循环，每帖 1 个
 * - 文案用 ==sep== 分隔（单条内可换行）
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

function takeCycling(pool: string[], cursor: number, count: number): { items: string[]; next: number } {
  const items: string[] = [];
  let c = cursor;
  for (let j = 0; j < count; j++) {
    items.push(pool[c % pool.length]!);
    c += 1;
  }
  return { items, next: c };
}

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
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
  const imagesPerPost = parsePositiveIntConfig(groupConfig.image_count ?? 1, 1);

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

  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];
  const perBrowserCounts = new Map<number, number>();

  const assignments: PostAssignment[] = [];
  if (evenDistribute) {
    for (let i = 0; i < contents.length; i++) {
      assignments.push({
        browserId: browserIds[i % browserIds.length]!,
        content: contents[i]!,
        mediaCursor: i * (mediaType === 'image' ? imagesPerPost : 1),
      });
    }
  } else {
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

    const st: PerBrowserScheduleState = perBrowserSchedule.get(browserId) ?? {
      dayOffset: 0,
      usedInDay: 0,
      cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
    };

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
  const modeSummary = evenDistribute
    ? `even distribute: ${contents.length} captions → ${browserIds.length} browsers`
    : `full list each: ${contents.length} captions × ${browserIds.length} browsers`;

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (${modeSummary}, ${mediaSummary}); ${countSummary}`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
