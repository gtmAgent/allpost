/**
 * 任务组分发：媒体与浏览器按确认规则配对。
 * - 1 个媒体 → 全部浏览器发同一份
 * - 多个媒体 → 按顺序一对一，条数 = min(浏览器, 媒体)，多出的丢弃
 * 文案：仅 1 行（或空）→ 全部共用；多行 → 与媒体按下标配对
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
  splitConfigLines,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

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

function normalizeMedias(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function captionForIndex(captions: string[], index: number): string {
  if (captions.length <= 1) return captions[0] ?? '';
  return captions[index] ?? captions[0] ?? '';
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const medias = normalizeMedias(groupConfig.medias);
  const captions = splitConfigLines(groupConfig.captions ?? '');
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);

  if (medias.length === 0) {
    return { succ: false, msg: '请至少选择一张图片或一个视频' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请选择至少一台浏览器' };
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

  type Pair = { browserId: number; media: string; caption: string };
  const pairs: Pair[] = [];

  if (medias.length === 1) {
    const media = medias[0]!;
    const caption = captionForIndex(captions, 0);
    for (const browserId of browserIds) {
      pairs.push({ browserId, media, caption });
    }
  } else {
    const n = Math.min(medias.length, browserIds.length);
    for (let i = 0; i < n; i++) {
      pairs.push({
        browserId: browserIds[i]!,
        media: medias[i]!,
        caption: captionForIndex(captions, i),
      });
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];

  for (const pair of pairs) {
    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(pair.browserId) ??
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
      deviceId: pair.browserId,
      target: manifest.target,
      config: {
        media: pair.media,
        caption: pair.caption,
      },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);
    perBrowserSchedule.set(pair.browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: '未生成任务（请检查媒体、浏览器与频率设置）' };
  }

  return {
    succ: true,
    msg: `generated ${tasks.length} tasks`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
