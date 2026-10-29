/**
 * Facebook 首页发帖：SOCIAL_HOME → 结构定位打开 composer → 文案 + 图片/视频 → 发布。
 * 主路径优先语言无关结构（role / :has / file input / blob 预览）；已观察语文案仅作兜底 OR。
 */
import type { TaskRunConfig } from './config.types';
import {
  type AutomationRunResult,
  automationFailWithContext,
  loadAutomationManifest,
  loadTaskRunConfig,
  nodePath,
  XportBrowserClient,
} from 'xport-browser-sdk';

const FB_HOME = 'https://www.facebook.com/';

/** Feed 发帖入口：含 file input 的 region 内、无 aria-label 的 prompt 按钮（不依赖界面语言）。 */
const createPostPath = nodePath()
  .css('div[role="region"]:has(input[type="file"])')
  .then()
  .css('div[role="button"]:not([aria-label])')
  .one();

/** 已观察语种的 region 兜底（结构失败时）；点 region 后再找 prompt 按钮。 */
const createPostRegionFallbackPath = nodePath()
  .css('div[aria-label="Create a post"]', 'div[aria-label="创建帖子"]')
  .then()
  .css('div[role="button"]:not([aria-label])')
  .one();

const modalDialog = 'div[role="dialog"][aria-modal="true"]';

/**
 * 真正的发帖 composer：同时含 textbox + file input。
 * FB 可能叠「Review audience」等教育弹层（无 textbox），勿用裸 modalDialog.one()。
 */
const composerDialog = `${modalDialog}:has(div[role="textbox"]):has(input[type="file"])`;

/** 遮挡层：modal 但无发帖 textbox（Review audience / 使用时长 Manage 等）。 */
const blockingDialogPath = nodePath()
  .css(`${modalDialog}:not(:has(div[role="textbox"]))`)
  .one();

/**
 * 遮挡层主按钮：须 scope 在无 textbox 的 modal 内（页面上可能另有 Confirm，如好友请求）。
 * 已观察 EN：Continue（受众教育）、Confirm（使用时长 Manage）、OK（You're in sleep mode）。
 */
const blockingDismissPath = nodePath()
  .css(`${modalDialog}:not(:has(div[role="textbox"]))`)
  .then()
  .css(
    'div[role="button"][aria-label="Continue"]',
    'div[role="button"][aria-label="Confirm"]',
    'div[role="button"][aria-label="OK"]',
  )
  .one();

const dialogTextboxPath = nodePath()
  .css(composerDialog)
  .then()
  .css('div[role="textbox"]')
  .one();

const dialogFileInputPath = nodePath()
  .css(composerDialog)
  .then()
  .css('input[type="file"]')
  .one();

const dialogImagePreviewPath = nodePath()
  .css(composerDialog)
  .then()
  .css('img[src^="blob:"]')
  .one();

const dialogVideoPath = nodePath()
  .css(composerDialog)
  .then()
  .css('video')
  .one();

/**
 * 发布按钮：弹窗底部结构化父级（语言无关）+ 已观察 aria-label 兜底。
 * 启用态用 :not([aria-disabled="true"])，避免点到灰色不可点状态。
 */
const dialogPostReadyPath = nodePath()
  .css(composerDialog)
  .then()
  .css(
    'div[class*="x4vbgl9"][class*="x1rdy4ex"] div[role="button"]:not([aria-disabled="true"])',
    'div[aria-label="Post"]:not([aria-disabled="true"])',
    'div[aria-label="发帖"]:not([aria-disabled="true"])',
  )
  .one();

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

function resolveHomeUrl(): string {
  const fromEnv = Bun.env.SOCIAL_HOME?.trim();
  if (fromEnv) {
    return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
  }
  return FB_HOME;
}

/** 打开首页后的 URL 态：checkpoint / 登录墙 / 已在 FB 可继续 / 其它。 */
function classifyFacebookUrl(pageUrl: string): 'checkpoint' | 'login' | 'on_fb' | 'other' {
  if (!pageUrl || !/facebook\.com/i.test(pageUrl)) return 'other';
  if (/\/checkpoint\//i.test(pageUrl) || /\/two_factor\b/i.test(pageUrl)) return 'checkpoint';
  if (/\/login\b/i.test(pageUrl) || /\/recover\b/i.test(pageUrl)) return 'login';
  return 'on_fb';
}

async function failStep(
  client: XportBrowserClient,
  step: string,
  reason: string,
  code: string,
  labels?: Record<string, string>,
): Promise<AutomationRunResult> {
  const [, , captured] = await client.captureIncident({
    step,
    reason,
    code,
    labels,
  });
  return automationFailWithContext(reason, {
    code,
    step,
    incidentId: captured?.incidentId,
    labels,
  });
}

async function failForFacebookUrlState(
  client: XportBrowserClient,
  state: 'checkpoint' | 'login',
  labels: Record<string, string>,
): Promise<AutomationRunResult> {
  if (state === 'checkpoint') {
    return failStep(
      client,
      'check_account',
      'This Facebook account is locked or on a security checkpoint. Unlock it in this browser profile (complete Meta security steps), then rerun.',
      'ACCOUNT_RESTRICTED',
      labels,
    );
  }
  return failStep(
    client,
    'check_login',
    'Browser is not logged in to Facebook. Please log in on this fingerprint profile first.',
    'NOT_LOGGED_IN',
    labels,
  );
}

/**
 * 打开 Facebook 首页：就绪检测 → domcontentloaded 导航（最多 2 次）→ 按 URL 归类账号态。
 * 返回 null 表示可继续发帖；否则为结构化 fail。
 */
async function ensureFacebookHome(
  client: XportBrowserClient,
  homeUrl: string,
  labels: Record<string, string>,
): Promise<AutomationRunResult | null> {
  const [preOk, , preUrlRaw] = await client.getPageUrl();
  if (preOk) {
    const preState = classifyFacebookUrl(preUrlRaw ?? '');
    if (preState === 'checkpoint' || preState === 'login') {
      return failForFacebookUrlState(client, preState, labels);
    }
    if (preState === 'on_fb') {
      client.taskLog(`open_home: already on Facebook (${preUrlRaw}); skip pageGoTo`);
      return null;
    }
  }

  let lastMsg = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [ok, msg] = await client.pageGoTo(0, {
      url: homeUrl,
      timeoutMs: 45_000,
      wait: 'domcontentloaded',
    });
    lastMsg = msg || '';
    await sleep(800);

    const [urlOk, , pageUrlRaw] = await client.getPageUrl();
    const pageUrl = pageUrlRaw ?? '';
    const state = urlOk ? classifyFacebookUrl(pageUrl) : 'other';
    if (state === 'checkpoint' || state === 'login') {
      return failForFacebookUrlState(client, state, labels);
    }
    if (ok || state === 'on_fb') {
      if (!ok) {
        client.taskLog(
          `pageGoTo attempt ${attempt} reported fail but already on FB (${pageUrl}); continue`,
        );
      }
      return null;
    }
    client.taskLog(`pageGoTo attempt ${attempt} failed: ${lastMsg || 'unknown'}`);
    if (attempt < 2) await sleep(1_200);
  }

  return failStep(
    client,
    'open_home',
    lastMsg || 'pageGoTo failed after retry',
    'NAV_FAILED',
    labels,
  );
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function waitForCount(
  client: XportBrowserClient,
  path: ReturnType<typeof nodePath>,
  pred: (n: number) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const [ok, , count] = await client.getNodeCount(0, path);
    last = ok && typeof count === 'number' ? count : 0;
    if (pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function quietDialog(client: XportBrowserClient, timeoutMs = 12_000): Promise<void> {
  const [ok, msg] = await client.waitForDomQuiet(0, {
    selector: composerDialog,
    stableMs: 600,
    timeoutMs,
  });
  if (!ok) client.taskLog(`waitForDomQuiet(dialog): ${msg}`);
}

/**
 * 关掉叠在发帖框上的教育/受众/使用时长/睡眠模式等弹层。
 * 只点「无 textbox」弹层里已观察的 Continue / Confirm / OK；最多若干轮。
 */
async function dismissBlockingDialogs(
  client: XportBrowserClient,
  maxRounds = 6,
): Promise<void> {
  for (let round = 1; round <= maxRounds; round++) {
    const [cOk, , dismissCount] = await client.getNodeCount(0, blockingDismissPath);
    const nDismiss = cOk && typeof dismissCount === 'number' ? dismissCount : 0;
    if (nDismiss < 1) {
      const [bOk, , blockCount] = await client.getNodeCount(0, blockingDialogPath);
      const nBlock = bOk && typeof blockCount === 'number' ? blockCount : 0;
      if (nBlock >= 1) {
        client.taskLog(
          `dismiss_blocking: dialog without textbox still present (count=${nBlock}) but no Continue/Confirm/OK; stop`,
        );
      }
      return;
    }
    client.taskLog(`dismiss_blocking round ${round}: click Continue/Confirm/OK (count=${nDismiss})`);
    await client.clickNode(0, blockingDismissPath, -1, { preferClickableAncestor: true });
    await sleep(900);
  }
  client.taskLog(`dismiss_blocking: reached maxRounds=${maxRounds}`);
}

/** contenteditable 回读会折叠空白；去零宽后再比，避免误判未写入。 */
function normalizeCompareText(s: string): string {
  return s.replace(/\u200b/g, '').replace(/\s+/g, '');
}

async function readComposerText(client: XportBrowserClient): Promise<string> {
  const [ok, , data] = await client.getNodeData(0, dialogTextboxPath, ['text']);
  if (!ok || !data) return '';
  const col = (data as { text?: string[] }).text;
  const raw = Array.isArray(col) ? col.map(String).join('\n') : '';
  return raw.replace(/\u200b/g, '').trim();
}

function composerContainsContent(got: string, wanted: string): boolean {
  const w = wanted.trim();
  if (!w) return false;
  return normalizeCompareText(got).includes(normalizeCompareText(w));
}

async function writeCaptionOnce(
  client: XportBrowserClient,
  content: string,
  strategy: 'paste' | 'typeInNode' | 'insertText',
): Promise<{ ok: boolean; msg: string }> {
  await client.clickNode(0, dialogTextboxPath);
  await sleep(350);
  await client.focusNode(0, dialogTextboxPath);
  await sleep(250);

  if (strategy === 'paste') {
    const [ok, msg] = await client.pasteText(0, dialogTextboxPath, content);
    return { ok, msg: msg || '' };
  }
  if (strategy === 'typeInNode') {
    const [ok, msg] = await client.typeInNode(0, dialogTextboxPath, content);
    return { ok, msg: msg || '' };
  }
  // insertText：先聚焦 textbox，再键盘插入（适合 IME/中文）
  const [ok, msg] = await client.insertText(0, content);
  return { ok, msg: msg || '' };
}

/**
 * 写入发帖文案后必须回读校验；未出现目标文案则换策略重试，仍失败则 fail。
 * 上传媒体后 FB 常会冲掉文案，调用方在预览就绪后再 ensure 一次。
 */
async function fillComposerContent(
  client: XportBrowserClient,
  content: string,
  labels: Record<string, string>,
  step: string,
  maxAttempts = 4,
): Promise<AutomationRunResult | null> {
  const strategies: Array<'paste' | 'typeInNode' | 'insertText'> = [
    'paste',
    'paste',
    'typeInNode',
    'insertText',
  ];
  let lastGot = '';
  let lastStrategy = 'paste';
  let lastWriteMsg = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await dismissBlockingDialogs(client, 4);

    const [tbOk, , tbCount] = await client.getNodeCount(0, dialogTextboxPath);
    if (!tbOk || !tbCount || tbCount < 1) {
      client.taskLog(
        `fill_content attempt ${attempt}: composer textbox not found (scoped dialog with file input)`,
      );
      await sleep(700);
      continue;
    }

    const strategy = strategies[Math.min(attempt - 1, strategies.length - 1)]!;
    lastStrategy = strategy;
    const write = await writeCaptionOnce(client, content, strategy);
    lastWriteMsg = write.msg;
    if (!write.ok) {
      client.taskLog(
        `fill_content attempt ${attempt}: ${strategy} failed — ${write.msg || 'unknown'}`,
      );
      await sleep(600);
      continue;
    }
    await sleep(800);
    lastGot = await readComposerText(client);
    if (composerContainsContent(lastGot, content)) {
      client.taskLog(
        `fill_content attempt ${attempt}: ok via ${strategy} (gotLen=${lastGot.length} preview=${lastGot.slice(0, 40)})`,
      );
      return null;
    }
    client.taskLog(
      `fill_content attempt ${attempt}: ${strategy} reported ok but readback empty/mismatch (gotLen=${lastGot.length} preview=${lastGot.slice(0, 40)})`,
    );
    await sleep(600);
  }

  const [bOk, , blockCount] = await client.getNodeCount(0, blockingDialogPath);
  const blocked = bOk && typeof blockCount === 'number' && blockCount >= 1;
  const reason = blocked
    ? `Could not write post caption: a blocking dialog is still on top of the composer (readback got="${lastGot.slice(0, 80)}"). Dismiss audience/education prompts (e.g. Continue), then rerun.`
    : `Post caption was not written into the composer textbox after ${maxAttempts} attempts (lastStrategy=${lastStrategy}, writeMsg=${lastWriteMsg || 'ok'}, got="${lastGot.slice(0, 80)}"). Refusing to publish empty caption.`;

  return await failStep(client, step, reason, 'CONTENT_WRITE_FAILED', labels);
}

/** 已有目标文案则跳过；否则补填并校验。 */
async function ensureComposerContent(
  client: XportBrowserClient,
  content: string,
  labels: Record<string, string>,
  step: string,
): Promise<AutomationRunResult | null> {
  const got = await readComposerText(client);
  if (composerContainsContent(got, content)) {
    client.taskLog(`ensure_content(${step}): already present (gotLen=${got.length})`);
    return null;
  }
  client.taskLog(
    `ensure_content(${step}): missing or cleared (gotLen=${got.length}); refilling`,
  );
  return fillComposerContent(client, content, labels, step);
}

async function openComposer(client: XportBrowserClient): Promise<boolean> {
  let count = await waitForCount(client, createPostPath, (n) => n >= 1, 20_000);
  let path = createPostPath;
  if (count < 1) {
    count = await waitForCount(client, createPostRegionFallbackPath, (n) => n >= 1, 8_000);
    path = createPostRegionFallbackPath;
  }
  if (count < 1) return false;
  await sleep(600);
  const [clickOk] = await client.clickNode(0, path);
  return clickOk;
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const mediaType = taskConfig.media_type === 'video' ? 'video' : 'image';
  const content = String(taskConfig.content ?? '').trim();
  const images = normalizeResources(taskConfig.images);
  const video =
    typeof taskConfig.video === 'string' && taskConfig.video.trim()
      ? taskConfig.video.trim()
      : '';
  const homeUrl = resolveHomeUrl();
  const mediaCount = mediaType === 'video' ? (video ? 1 : 0) : images.length;
  const labels = {
    mediaType,
    contentPreview: content.slice(0, 80),
    mediaCount: String(mediaCount),
    homeUrl,
  };

  client.taskLog(
    `home=${homeUrl} mediaType=${mediaType} contentLen=${content.length} mediaCount=${mediaCount}`,
  );

  if (!content) {
    return automationFailWithContext('content is required in taskRunConfig', {
      code: 'UNKNOWN',
      step: 'validate_content',
    });
  }
  if (mediaType === 'image' && images.length === 0) {
    return automationFailWithContext('images is required when media_type=image', {
      code: 'UNKNOWN',
      step: 'validate_images',
    });
  }
  if (mediaType === 'video' && !video) {
    return automationFailWithContext('video is required when media_type=video (one per post)', {
      code: 'UNKNOWN',
      step: 'validate_video',
    });
  }

  try {
    const homeGate = await ensureFacebookHome(client, homeUrl, labels);
    if (homeGate) return homeGate;

    // 首页可能已叠受众教育弹层；开 composer 前先清一次
    await dismissBlockingDialogs(client, 4);

    const opened = await openComposer(client);
    if (!opened) {
      return await failStep(
        client,
        'find_create_post',
        'Create post control not found (structure + observed-label fallback). Check login / Feed UI.',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    // 点开「发帖」后 FB 常再弹出 Review audience 等遮挡层，须先关掉再等 composer
    await sleep(600);
    await dismissBlockingDialogs(client, 6);

    const textboxCount = await waitForCount(client, dialogTextboxPath, (n) => n >= 1, 15_000);
    if (textboxCount < 1) {
      return await failStep(
        client,
        'wait_composer_dialog',
        'Post composer dialog did not open (or is still covered by another modal).',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    await sleep(500);
    const fillFail = await fillComposerContent(client, content, labels, 'fill_content');
    if (fillFail) return fillFail;

    const fileCount = await waitForCount(client, dialogFileInputPath, (n) => n >= 1, 10_000);
    if (fileCount < 1) {
      return await failStep(
        client,
        'find_file_input',
        'File input not found in post dialog',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    if (mediaType === 'video') {
      const [upOk, upMsg] = await client.uploadFile(0, dialogFileInputPath, video);
      if (!upOk) {
        return await failStep(client, 'upload_video', upMsg || 'uploadFile failed', 'UNKNOWN', labels);
      }
      const videoReady = await waitForCount(client, dialogVideoPath, (n) => n >= 1, 90_000, 800);
      if (videoReady < 1) {
        return await failStep(
          client,
          'wait_video_preview',
          'Video preview did not appear in the composer dialog',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      await quietDialog(client, 20_000);
    } else if (images.length === 1) {
      const [upOk, upMsg] = await client.uploadFile(0, dialogFileInputPath, images[0]!);
      if (!upOk) {
        return await failStep(client, 'upload_images', upMsg || 'uploadFile failed', 'UNKNOWN', labels);
      }
      const imgReady = await waitForCount(client, dialogImagePreviewPath, (n) => n >= 1, 60_000, 600);
      if (imgReady < 1) {
        return await failStep(
          client,
          'wait_image_preview',
          'Image preview (blob) did not appear in the composer dialog',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      await quietDialog(client, 15_000);
    } else {
      const [upOk, upMsg] = await client.uploadFiles(0, dialogFileInputPath, images);
      if (!upOk) {
        return await failStep(client, 'upload_images', upMsg || 'uploadFiles failed', 'UNKNOWN', labels);
      }
      const imgReady = await waitForCount(
        client,
        dialogImagePreviewPath,
        (n) => n >= 1,
        90_000,
        600,
      );
      if (imgReady < 1) {
        return await failStep(
          client,
          'wait_image_preview',
          'Image preview (blob) did not appear after multi-upload',
          'ELEMENT_NOT_FOUND',
          labels,
        );
      }
      await quietDialog(client, 20_000);
    }

    // 上传预览后 FB 常冲掉 caption：必须再检查/补填，确认文案仍在再点 Post
    await sleep(800);
    const afterMediaFail = await ensureComposerContent(
      client,
      content,
      labels,
      'refill_content_after_media',
    );
    if (afterMediaFail) return afterMediaFail;

    const postBtnCount = await waitForCount(client, dialogPostReadyPath, (n) => n >= 1, 20_000);
    if (postBtnCount < 1) {
      return await failStep(
        client,
        'find_post_button',
        'Enabled Post button not found in dialog',
        'ELEMENT_NOT_FOUND',
        labels,
      );
    }

    // 点发布前再验：媒体就绪但文案为空时不得点 Post（即使按钮可点）
    const beforePostFail = await ensureComposerContent(
      client,
      content,
      labels,
      'verify_content_before_post',
    );
    if (beforePostFail) return beforePostFail;

    await client.scrollNodeIntoView(0, dialogPostReadyPath);
    await sleep(500);

    const publishTimeoutMs = mediaType === 'video' ? 180_000 : 90_000;
    const publishDeadline = Date.now() + publishTimeoutMs;
    let published = false;
    while (Date.now() < publishDeadline) {
      const ready = await waitForCount(client, dialogPostReadyPath, (n) => n >= 1, 5_000, 400);
      if (ready >= 1) {
        await client.scrollNodeIntoView(0, dialogPostReadyPath);
        await sleep(400);
        const [postOk, postMsg] = await client.clickNode(0, dialogPostReadyPath, -1, {
          preferClickableAncestor: true,
        });
        if (!postOk) {
          client.taskLog(`click Post: ${postMsg}`);
        }
      }
      await sleep(mediaType === 'video' ? 2500 : 1500);
      const [, , remaining] = await client.getNodeCount(0, dialogTextboxPath);
      if ((remaining ?? 0) === 0) {
        published = true;
        break;
      }
      await quietDialog(client, 8_000);
    }

    if (!published) {
      return await failStep(
        client,
        'publish_post',
        'Post dialog did not close after clicking Post. Publishing may still be in progress or blocked.',
        'UNKNOWN',
        labels,
      );
    }

    const [finalUrlOk, , finalUrl] = await client.getPageUrl();
    return {
      succ: true,
      msg: mediaType === 'video' ? 'video post published' : 'image post published',
      data: {
        mediaType,
        content,
        mediaCount,
        finalUrl: finalUrlOk ? finalUrl : homeUrl,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN', labels);
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(
  await XportBrowserClient.run((client) => runAutomation(client, taskConfig)),
);
