/**
 * Instagram 网页发帖：首页 → Create(+) → 注入媒体 → Crop(Original) → Next → Next → 文案 → Share。
 * 主路径优先语言无关结构（SVG path / dialog header 槽位 / role=textbox）；文案仅作已观察语种兜底。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  type NodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const MIN_MEDIA_BYTES = 1024;
const STEP_PAUSE_MS = 800;
const HOME = () => (Bun.env.SOCIAL_HOME?.trim() || 'https://www.instagram.com').replace(/\/$/, '');

/** Create(+)：加号 SVG path，与界面语言无关（现场中/英均验证）。 */
const CREATE_PLUS_PATH = 'svg path[d*="M21 11h-8V3"]';
/** 关闭弹层 X：polyline 几何，与「关闭/Close」文案无关。 */
const CLOSE_X_POLY = 'svg polyline[points*="20.643 3.357"]';
/** Crop 比例菜单入口：裁剪图标 path（录制 Select crop）。 */
const SELECT_CROP_PATH = 'svg path[d*="M10 20H4v-6"]';
/** Crop 菜单「Original」旁 Photo outline 图标 path（录制 step004，语言无关）。 */
const ORIGINAL_CROP_ICON = 'svg path[d*="M6.549 5.013"]';
/** 滤镜页默认「Original」：录制 step005 img alt=Filter: Normal。 */
const FILTER_NORMAL_IMG = 'img[alt="Filter: Normal"]';
/** 发帖弹窗头部右侧动作槽（继续/Next、分享/Share、完成/Done 共用）。 */
const DIALOG_HEADER_ACTION = '._ac7b._ac7d [role="button"]';
/** Instagram 丢弃确认按钮品牌红（放弃/Discard）。 */
const DISCARD_RED = '#ed4956';

async function pause(ms = STEP_PAUSE_MS): Promise<void> {
  await Bun.sleep(ms);
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({ step, reason, code, labels });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function countOf(client: XportBrowserClient, path: NodePath): Promise<number> {
  const [ok, , n] = await client.getNodeCount(0, path);
  return ok && typeof n === 'number' ? n : 0;
}

async function clickPath(
  client: XportBrowserClient,
  path: NodePath,
  opts?: { preferClickableAncestor?: boolean },
): Promise<boolean> {
  const [ok] = await client.clickNode(0, path, -1, {
    preferClickableAncestor: opts?.preferClickableAncestor === true,
  });
  return ok;
}

async function waitForCount(
  client: XportBrowserClient,
  path: NodePath,
  min: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countOf(client, path)) >= min) return true;
    await Bun.sleep(400);
  }
  return false;
}

function dialogRoot(): NodePath {
  return nodePath().css('div[role="dialog"]').one();
}

/** 发帖弹窗头部右侧主按钮（语言无关）。 */
function headerActionPath(): NodePath {
  return nodePath().css('div[role="dialog"]').then().css(DIALOG_HEADER_ACTION).one();
}

function captionBoxPath(): NodePath {
  return nodePath()
    .css('div[role="dialog"]')
    .then()
    .css('div[role="textbox"][contenteditable="true"]')
    .one();
}

function fileInputPath(): NodePath {
  return nodePath().css('input[type="file"]').one();
}

async function clickHeaderAction(client: XportBrowserClient): Promise<boolean> {
  const btn = headerActionPath();
  if ((await countOf(client, btn)) < 1) return false;
  return clickPath(client, btn);
}

/** 滤镜/Edit 步信号：录制已观察 Filter: Normal（语言无关 alt）。 */
function editFilterMarkerPath(): NodePath {
  return nodePath().css('div[role="dialog"]').then().css(FILTER_NORMAL_IMG).one();
}

/**
 * 从 Crop/Edit 连点头部右侧主按钮，直到出现文案框。
 * 现场：Edit 页点 Next 可能短暂转圈、点击被吞；单次 click + 死等会卡在 wait_caption。
 * 每次先查 caption，避免误点 Share。
 */
async function advanceUntilCaption(
  client: XportBrowserClient,
  timeoutMs: number,
): Promise<boolean> {
  const caption = captionBoxPath();
  const headerBtn = headerActionPath();
  const deadline = Date.now() + timeoutMs;
  let clicks = 0;
  const maxClicks = 6;

  while (Date.now() < deadline) {
    if ((await countOf(client, caption)) >= 1) {
      client.taskLog(`caption ready after ${clicks} advance click(s)`);
      return true;
    }
    if (clicks >= maxClicks) break;
    if ((await countOf(client, headerBtn)) < 1) {
      await Bun.sleep(400);
      continue;
    }
    if (!(await clickPath(client, headerBtn))) {
      await Bun.sleep(500);
      continue;
    }
    clicks += 1;
    client.taskLog(`wizard advance click #${clicks}`);
    // 点后可能短暂转圈：先等文案框，再决定是否重试（避免连点误触 Share）
    const settleUntil = Date.now() + 8_000;
    while (Date.now() < settleUntil) {
      if ((await countOf(client, caption)) >= 1) {
        client.taskLog(`caption ready after ${clicks} advance click(s)`);
        return true;
      }
      await Bun.sleep(400);
    }
  }
  return (await countOf(client, caption)) >= 1;
}

async function dismissLeftoverCreate(client: XportBrowserClient): Promise<void> {
  const discardBtn = nodePath()
    .css('div[role="dialog"]')
    .then()
    .pColor(DISCARD_RED, 40, 'button')
    .one();
  if ((await countOf(client, discardBtn)) >= 1) {
    await clickPath(client, discardBtn);
    await pause();
  }

  const closeX = nodePath().css(CLOSE_X_POLY).one();
  if ((await countOf(client, closeX)) >= 1) {
    await clickPath(client, closeX, { preferClickableAncestor: true });
    await pause();
    if ((await countOf(client, discardBtn)) >= 1) {
      await clickPath(client, discardBtn);
      await pause();
    }
  }

  // 仍残留 file input / 发帖 dialog 时再试关一次
  if ((await countOf(client, fileInputPath())) >= 1 || (await countOf(client, dialogRoot())) >= 1) {
    if ((await countOf(client, closeX)) >= 1) {
      await clickPath(client, closeX, { preferClickableAncestor: true });
      await pause();
      if ((await countOf(client, discardBtn)) >= 1) {
        await clickPath(client, discardBtn);
        await pause();
      }
    }
  }
}

async function clickCreate(client: XportBrowserClient): Promise<boolean> {
  const create = nodePath().css(CREATE_PLUS_PATH).one();
  if ((await countOf(client, create)) < 1) return false;
  return clickPath(client, create, { preferClickableAncestor: true });
}

/**
 * Crop 步：打开比例菜单并点「Original / 原版」。
 * 主锚点：Photo outline 图标 path（语言无关）；文案仅用录制已观察 Original/原版。
 * 无入口或无选项则跳过并打日志（不中断发帖）。
 */
async function selectOriginalCrop(client: XportBrowserClient): Promise<void> {
  const selectCrop = nodePath().css('div[role="dialog"]').then().css(SELECT_CROP_PATH).one();
  if (!(await waitForCount(client, selectCrop, 1, 12_000))) {
    client.taskLog('Select crop not found; skip Original crop');
    return;
  }
  if (!(await clickPath(client, selectCrop, { preferClickableAncestor: true }))) {
    client.taskLog('Select crop click failed; skip Original crop');
    return;
  }
  await pause(1000);

  // 比例数字「1:1」语言无关，用作菜单已打开信号（containAnyText 勿 .one()：现场 count 会变 0）
  const ratioMarker = nodePath()
    .css('div[role="dialog"]')
    .then()
    .css('[role="button"]')
    .containAnyText('1:1');
  // 录制：Original 选项旁 svg path M6.549…（Photo outline icon）
  const originalIcon = nodePath().css('div[role="dialog"]').then().css(ORIGINAL_CROP_ICON).one();
  // 现场已观察：英文 Original、中文 原版（须 dialog 内，避免误点 Feed「Original audio」）
  const originalBtn = nodePath()
    .css('div[role="dialog"]')
    .then()
    .css('[role="button"]')
    .containAnyText('Original', '原版');

  const menuDeadline = Date.now() + 10_000;
  while (Date.now() < menuDeadline) {
    if ((await countOf(client, originalIcon)) >= 1) {
      if (await clickPath(client, originalIcon, { preferClickableAncestor: true })) {
        client.taskLog('Clicked Original crop (icon)');
        await pause();
        return;
      }
    }
    if ((await countOf(client, originalBtn)) >= 1) {
      if (await clickPath(client, originalBtn)) {
        client.taskLog('Clicked Original crop (text)');
        await pause();
        return;
      }
    }
    // 菜单未开则多等；已开仍无 Original 则等到 deadline 再放弃（勿见 1:1 就提前 break）
    if ((await countOf(client, ratioMarker)) < 1) {
      await Bun.sleep(300);
      continue;
    }
    await Bun.sleep(300);
  }
  client.taskLog('Original crop option miss; continue with default crop');
}

/**
 * Edit/滤镜步：若出现 Original（Filter: Normal）则点选；没有则跳过打日志。
 * 文案/alt 仅用录制 step005 已观察值。
 */
async function selectOriginalFilter(client: XportBrowserClient): Promise<void> {
  const byAlt = nodePath().css('div[role="dialog"]').then().css(FILTER_NORMAL_IMG).one();
  // containAnyText 路径勿 .one()（与 Crop Original 同坑）
  const byText = nodePath()
    .css('div[role="dialog"]')
    .then()
    .css('button')
    .containAnyText('Original');
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if ((await countOf(client, byAlt)) >= 1) {
      if (await clickPath(client, byAlt, { preferClickableAncestor: true })) {
        client.taskLog('Clicked Original filter (Filter: Normal)');
        await pause();
        return;
      }
    }
    if ((await countOf(client, byText)) >= 1) {
      if (await clickPath(client, byText)) {
        client.taskLog('Clicked Original filter (text)');
        await pause();
        return;
      }
    }
    await Bun.sleep(300);
  }
  client.taskLog('Original filter option miss; skip');
}

/**
 * Share 后：文案框消失 → 头部右侧再出现按钮（完成/Done）即视为成功。
 * 不依赖「Post shared / 帖子已分享」等语文案。
 */
async function waitSharedSuccess(client: XportBrowserClient, timeoutMs: number): Promise<boolean> {
  const caption = captionBoxPath();
  const doneBtn = headerActionPath();
  const deadline = Date.now() + timeoutMs;

  // 先等离开文案页（分享中弹层无 textbox）
  while (Date.now() < deadline) {
    if ((await countOf(client, caption)) < 1) break;
    await Bun.sleep(500);
  }
  if ((await countOf(client, caption)) >= 1) return false;

  // 再等成功页「完成」槽位出现（分享中短暂无头部右侧按钮）
  while (Date.now() < deadline) {
    if ((await countOf(client, doneBtn)) >= 1) return true;
    // dialog 已关也视为成功（部分环境点完自动收起）
    if ((await countOf(client, dialogRoot())) < 1) return true;
    await Bun.sleep(500);
  }
  return (await countOf(client, doneBtn)) >= 1 || (await countOf(client, dialogRoot())) < 1;
}

async function runAutomation(client: XportBrowserClient, taskConfig: TaskRunConfig): Promise<AutomationRunResult> {
  const media = (taskConfig.media ?? '').toString().trim();
  const caption = (taskConfig.caption ?? '').toString();
  client.taskLog(`media=${media || '(empty)'} captionLen=${caption.length}`);

  if (!media) {
    return automationFailWithContext('请选择要发布的图片或视频', {
      code: 'UNKNOWN',
      step: 'validate_media',
    });
  }

  try {
    const [metaOk, metaMsg, meta] = await client.getResourceByMd5(media);
    if (!metaOk || !meta) {
      return await failStep(
        client,
        'resolve_media',
        `无法读取媒体资源：${metaMsg || 'unknown'}`,
        'UNKNOWN',
        { media },
      );
    }
    if (typeof meta.size === 'number' && meta.size > 0 && meta.size < MIN_MEDIA_BYTES) {
      return await failStep(
        client,
        'resolve_media',
        `媒体过小（${meta.size} 字节），Instagram 要求至少 1KB`,
        'UNKNOWN',
        { media, size: String(meta.size) },
      );
    }

    const home = HOME();
    const [goOk, goMsg] = await client.pageGoTo(0, { url: `${home}/`, timeoutMs: 60_000 });
    if (!goOk) {
      return await failStep(client, 'open_home', goMsg || '打开 Instagram 首页失败', 'NAV_FAILED', {
        home,
      });
    }
    await pause(1200);

    const [urlOk, , pageUrl] = await client.getPageUrl();
    if (urlOk && /\/accounts\/login/i.test(pageUrl || '')) {
      return await failStep(client, 'check_login', '浏览器未登录 Instagram，请先登录后再跑', 'NOT_LOGGED_IN');
    }

    await dismissLeftoverCreate(client);

    // 等侧栏 Create 图标就绪
    const createIcon = nodePath().css(CREATE_PLUS_PATH).one();
    if (!(await waitForCount(client, createIcon, 1, 20_000))) {
      return await failStep(client, 'click_create', '找不到发帖入口（Create +）', 'ELEMENT_NOT_FOUND');
    }
    if (!(await clickCreate(client))) {
      return await failStep(client, 'click_create', '点击发帖入口失败', 'ELEMENT_NOT_FOUND');
    }
    await pause();

    if (!(await waitForCount(client, fileInputPath(), 1, 20_000))) {
      return await failStep(client, 'wait_file_input', '发帖弹窗未出现文件上传控件', 'ELEMENT_NOT_FOUND');
    }

    const [upOk, upMsg] = await client.uploadFile(0, fileInputPath(), media);
    if (!upOk) {
      return await failStep(client, 'upload_media', upMsg || '上传媒体失败', 'UNKNOWN', { media });
    }
    await pause(1500);

    // 等进入 Crop：比例按钮或头部「继续」
    const selectCrop = nodePath().css('div[role="dialog"]').then().css(SELECT_CROP_PATH).one();
    const headerBtn = headerActionPath();
    const cropReadyDeadline = Date.now() + 25_000;
    let cropReady = false;
    while (Date.now() < cropReadyDeadline) {
      if ((await countOf(client, selectCrop)) >= 1 || (await countOf(client, headerBtn)) >= 1) {
        cropReady = true;
        break;
      }
      await Bun.sleep(400);
    }
    if (!cropReady) {
      return await failStep(client, 'wait_crop', '上传后未进入裁剪步骤', 'ELEMENT_NOT_FOUND');
    }

    await selectOriginalCrop(client);

    if (!(await clickHeaderAction(client))) {
      return await failStep(client, 'crop_next', '裁剪步骤找不到下一步', 'ELEMENT_NOT_FOUND');
    }
    await pause(1200);

    // 等离开裁剪：出现滤镜标记或已到文案页（避免过早当 Edit 点 Next，实际只走了 Crop→Edit）
    const afterCropDeadline = Date.now() + 20_000;
    let leftCrop = false;
    while (Date.now() < afterCropDeadline) {
      if ((await countOf(client, captionBoxPath())) >= 1) {
        leftCrop = true;
        break;
      }
      if ((await countOf(client, editFilterMarkerPath())) >= 1) {
        leftCrop = true;
        break;
      }
      // 裁剪入口已消失也视为进入后续步
      if ((await countOf(client, selectCrop)) < 1 && (await countOf(client, headerBtn)) >= 1) {
        leftCrop = true;
        break;
      }
      await Bun.sleep(400);
    }
    if (!leftCrop) {
      return await failStep(client, 'crop_next', '裁剪后未进入编辑/文案步骤', 'ELEMENT_NOT_FOUND');
    }

    // 编辑/滤镜页：有 Original 则点（已在文案页则跳过）
    if ((await countOf(client, captionBoxPath())) < 1) {
      await selectOriginalFilter(client);
      await pause(800);
    }

    // Edit→文案：可重试点头部 Next（现场偶发点击未生效 / 转圈）
    if (!(await advanceUntilCaption(client, 45_000))) {
      return await failStep(client, 'wait_caption', '未进入文案页', 'ELEMENT_NOT_FOUND');
    }
    if (caption.trim()) {
      const [tOk, tMsg] = await client.typeInNode(0, captionBoxPath(), caption);
      if (!tOk) {
        return await failStep(client, 'type_caption', tMsg || '填写文案失败', 'UNKNOWN');
      }
    }
    await pause();

    if (!(await clickHeaderAction(client))) {
      return await failStep(client, 'click_share', '找不到分享按钮', 'ELEMENT_NOT_FOUND');
    }
    await pause(1500);

    if (!(await waitSharedSuccess(client, 90_000))) {
      return await failStep(client, 'wait_shared', '等待发帖成功超时', 'UNKNOWN');
    }

    const done = headerActionPath();
    if ((await countOf(client, done)) >= 1) {
      await clickPath(client, done);
      await pause();
    }

    const [, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: '发帖成功',
      data: {
        caption,
        mediaMd5: media,
        finalUrl: finalUrl || '',
        shared: '1',
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return await failStep(client, 'unexpected', reason || '未预期异常', 'UNKNOWN', { media });
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
