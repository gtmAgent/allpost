/**
 * 多平台同素材发帖：文案循环、素材按平台内只用一次。
 * 启动只勾选浏览器；按设备所属社媒平台自动路由到对应发帖脚本。
 * 支持 FB / IG / Threads / TikTok / X。不同浏览器并行发帖；同一浏览器多帖仍串行。
 * 失败策略：单帖失败记录后继续。
 */
import type { WorkflowRunConfig } from './config.types';
import {
  automationHttpUrl,
  loadWorkflowManifest,
  loadWorkflowRunConfig,
  postCmdRespJson,
  resolveAiDesktopBaseUrl,
  type AutomationRunResult,
  type WorkflowContext,
  XportWorkflowClient,
} from 'xport-workflow-sdk';

type MediaType = 'image' | 'video';

type ChannelId = 'fb' | 'ins' | 'th' | 'tk' | 'x';

type PostItem = {
  caption: string;
  mediaMd5: string;
};

type BrowserDeviceRow = {
  id?: number;
  deviceId?: number;
  platform?: string;
};

const CHANNEL_LABEL: Record<ChannelId, string> = {
  fb: 'Facebook',
  ins: 'Instagram',
  th: 'Threads',
  tk: 'TikTok',
  x: 'X',
};

/** 桌面社媒 platform wire → 本工作流渠道 */
function platformToChannel(platform: string): ChannelId | null {
  const p = platform.trim().toLowerCase();
  if (p === 'facebook') return 'fb';
  if (p === 'instagram') return 'ins';
  if (p === 'threads') return 'th';
  if (p === 'tiktok') return 'tk';
  if (p === 'twitter' || p === 'x') return 'x';
  return null;
}

function parseBrowserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
}

function parseResourceList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s ?? '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/** 多条文案用 ==sep== 分隔；无分隔符时整段算一条。 */
function parseCaptions(raw: unknown): string[] {
  const text = String(raw ?? '');
  if (!text.trim()) return [];
  if (!text.includes('==sep==')) return [text.trim()];
  return text
    .split('==sep==')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildPosts(captions: string[], mediaList: string[]): PostItem[] {
  return mediaList.map((mediaMd5, i) => ({
    mediaMd5,
    caption: captions[i % captions.length]!,
  }));
}

function deviceRowId(row: BrowserDeviceRow): number | null {
  if (typeof row.deviceId === 'number' && Number.isInteger(row.deviceId) && row.deviceId > 0) {
    return row.deviceId;
  }
  if (typeof row.id === 'number' && Number.isInteger(row.id) && row.id > 0) {
    return row.id;
  }
  return null;
}

/** 批量查询浏览器，按平台分组（仅支持本工作流可发帖的平台）。 */
async function groupBrowsersByChannel(
  ids: number[],
): Promise<{ groups: Map<ChannelId, number[]>; notes: string[] }> {
  const notes: string[] = [];
  const groups = new Map<ChannelId, number[]>();
  const [ok, msg, data] = await postCmdRespJson<{ devices?: BrowserDeviceRow[] }>(
    globalThis.fetch.bind(globalThis),
    automationHttpUrl(resolveAiDesktopBaseUrl(), '/devices/query'),
    { target: 'browser', ids },
    'queryBrowserDevices',
  );
  if (!ok || !data?.devices) {
    notes.push(`查询浏览器平台失败: ${msg || 'unknown'}`);
    return { groups, notes };
  }

  const found = new Set<number>();
  for (const row of data.devices) {
    const id = deviceRowId(row);
    if (id == null) continue;
    found.add(id);
    const platform = String(row.platform ?? '').trim();
    const channel = platformToChannel(platform);
    if (!channel) {
      notes.push(`浏览器 ${id} 平台「${platform || '?'}」暂不支持发帖，跳过`);
      continue;
    }
    const list = groups.get(channel) ?? [];
    list.push(id);
    groups.set(channel, list);
  }
  for (const id of ids) {
    if (!found.has(id)) {
      notes.push(`浏览器 ${id} 未找到，跳过`);
    }
  }
  return { groups, notes };
}

async function postOne(
  ctx: WorkflowContext,
  channel: ChannelId,
  deviceId: number,
  mediaType: MediaType,
  post: PostItem,
): Promise<AutomationRunResult> {
  if (channel === 'fb') {
    return ctx.runAutomation({
      cmd: 'fb-post',
      deviceId,
      target: 'browser',
      config: {
        media_type: mediaType,
        content: post.caption,
        images: mediaType === 'image' ? [post.mediaMd5] : [],
        video: mediaType === 'video' ? post.mediaMd5 : null,
      },
    });
  }
  if (channel === 'ins') {
    return ctx.runAutomation({
      cmd: 'ins-post',
      deviceId,
      target: 'browser',
      config: {
        media: post.mediaMd5,
        caption: post.caption,
      },
    });
  }
  if (channel === 'th') {
    return ctx.runAutomation({
      cmd: 'th-post',
      deviceId,
      target: 'browser',
      config: {
        content: post.caption,
        image: mediaType === 'image' ? post.mediaMd5 : null,
        video: mediaType === 'video' ? post.mediaMd5 : null,
      },
    });
  }
  if (channel === 'tk') {
    return ctx.runAutomation({
      cmd: 'tk-post-personally',
      deviceId,
      target: 'browser',
      config: {
        media_type: mediaType,
        content: post.caption,
        images: mediaType === 'image' ? [post.mediaMd5] : [],
        video: mediaType === 'video' ? post.mediaMd5 : null,
      },
    });
  }
  return ctx.runAutomation({
    cmd: 'twitter-create-post-with-media',
    deviceId,
    target: 'browser',
    config: {
      media_type: mediaType,
      content: post.caption,
      media: mediaType === 'image' ? [post.mediaMd5] : [],
      video: mediaType === 'video' ? post.mediaMd5 : null,
    },
  });
}

async function runWorkflow(ctx: WorkflowContext, cfg: WorkflowRunConfig): Promise<AutomationRunResult> {
  const mediaType = (String(cfg.media_type || 'video') === 'image' ? 'image' : 'video') as MediaType;
  const captions = parseCaptions(cfg.captions);
  const mediaList =
    mediaType === 'image' ? parseResourceList(cfg.images) : parseResourceList(cfg.videos);
  const browserIds = parseBrowserIds(cfg.browsers);

  if (captions.length === 0) {
    return { succ: false, msg: '请至少填写一条文案（多条用 ==sep== 分隔）' };
  }
  if (mediaList.length === 0) {
    return {
      succ: false,
      msg: mediaType === 'image' ? '请至少选择一张图片' : '请至少选择一个视频',
    };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请至少勾选一台浏览器' };
  }

  const posts = buildPosts(captions, mediaList);
  const { groups, notes: queryNotes } = await groupBrowsersByChannel(browserIds);
  const notes = [...queryNotes];

  if (groups.size === 0) {
    return {
      succ: false,
      msg: `所选浏览器均无法发帖${notes.length ? `：${notes.join('；')}` : ''}`,
      data: { posted_ok: 0, posted_fail: 0, skipped: browserIds.length, summary: notes.join('；') },
    };
  }

  ctx.workflowLog(
    `media=${mediaType} posts=${posts.length} captions=${captions.length} channels=${[
      ...groups.entries(),
    ]
      .map(([id, ids]) => `${id}:${ids.length}`)
      .join(',')}`,
  );

  let postedOk = 0;
  let postedFail = 0;
  let skipped = notes.length;

  type Job = {
    channel: ChannelId;
    deviceId: number;
    postIndex: number;
    post: PostItem;
  };
  const jobs: Job[] = [];

  for (const [channel, browsers] of groups) {
    if (browsers.length > posts.length) {
      const extra = browsers.length - posts.length;
      skipped += extra;
      notes.push(
        `${CHANNEL_LABEL[channel]}：浏览器 ${browsers.length} 台多于素材 ${posts.length}，多余 ${extra} 台跳过`,
      );
    }

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i]!;
      const deviceId = browsers[i % browsers.length]!;
      jobs.push({ channel, deviceId, postIndex: i + 1, post });
    }
  }

  // 不同浏览器并行；同一浏览器多帖仍串行（避免同设备抢占）。
  const byDevice = new Map<number, Job[]>();
  for (const job of jobs) {
    const list = byDevice.get(job.deviceId) ?? [];
    list.push(job);
    byDevice.set(job.deviceId, list);
  }

  ctx.workflowLog(
    `parallel enqueue: jobs=${jobs.length} devices=${byDevice.size}`,
  );

  const deviceRuns = [...byDevice.entries()].map(async ([deviceId, deviceJobs]) => {
    const results: Array<{ job: Job; step: AutomationRunResult }> = [];
    for (const job of deviceJobs) {
      ctx.workflowLog(
        `${CHANNEL_LABEL[job.channel]} ${job.postIndex}/${posts.length} device=${deviceId} media=${job.post.mediaMd5.slice(0, 8)}…`,
      );
      const step = await postOne(ctx, job.channel, deviceId, mediaType, job.post);
      results.push({ job, step });
    }
    return results;
  });

  const settled = await Promise.all(deviceRuns);
  for (const results of settled) {
    for (const { job, step } of results) {
      if (step.succ) {
        postedOk += 1;
      } else {
        postedFail += 1;
        notes.push(
          `${CHANNEL_LABEL[job.channel]} 第 ${job.postIndex} 帖失败(device=${job.deviceId}): ${step.msg || 'unknown'}`,
        );
        ctx.workflowLog(`fail: ${CHANNEL_LABEL[job.channel]} #${job.postIndex} ${step.msg || ''}`);
      }
    }
  }

  const summaryParts = [
    `成功 ${postedOk}`,
    `失败 ${postedFail}`,
    `跳过 ${skipped}`,
    `每平台帖数 ${posts.length}`,
  ];
  if (notes.length) summaryParts.push(notes.slice(0, 12).join('；'));

  const summary = summaryParts.join(' · ');
  const allFailed = postedOk === 0 && postedFail > 0;
  return {
    succ: !allFailed,
    msg: allFailed ? `全部发帖失败：${summary}` : `完成：${summary}`,
    data: {
      posted_ok: postedOk,
      posted_fail: postedFail,
      skipped,
      summary,
    },
  };
}

const manifest = await loadWorkflowManifest();
const runConfig = await loadWorkflowRunConfig<WorkflowRunConfig>(manifest);

process.exit(await XportWorkflowClient.run((ctx) => runWorkflow(ctx, runConfig)));
