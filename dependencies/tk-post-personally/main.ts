/**
 * TikTok Studio 个人发帖：打开上传页 → Videos/Photos → 注入媒体 → 处理弹窗 → 文案 → Post。
 * 选择器以 MCP 现场 data-e2e / role=tab / file input 为准；已观察英文弹窗文案仅作 OR 兜底。
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

const STEP_PAUSE_MS = 900;
const UPLOAD_URL_VIDEO = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video';
const UPLOAD_URL_PHOTO = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=photo';

const tabVideoPath = nodePath().css('button[role="tab"][aria-controls="panel-video"]').one();
const tabPhotoPath = nodePath().css('button[role="tab"][aria-controls="panel-photo"]').one();
const fileInputPath = nodePath().css('input[type="file"]').one();
const captionPath = nodePath()
  .css('[data-e2e="caption_container"] .public-DraftEditor-content[contenteditable="true"]')
  .one();
/** 视频页有 data-e2e；图文编辑页无该属性，用主色 Post 按钮（排除侧栏 Upload） */
const postBtnPath = nodePath()
  .css(
    'button[data-e2e="post_video_button"]:not([aria-disabled="true"]):not([data-disabled="true"])',
    'button.Button__root--type-primary:not([data-tt]):not([aria-disabled="true"]):not([data-disabled="true"])',
  )
  .containAnyText('Post')
  .one();
const uploadStatusPath = nodePath().css('[data-e2e="upload_status_container"]').one();
/** 图文编辑页现场：Photos 区文案 "1 photo uploaded"（无 upload_status_container） */
const photoUploadedPath = nodePath()
  .css('::-p-text(photo uploaded)', '::-p-text(photos uploaded)')
  .one();
const selectVideoContainerPath = nodePath().css('[data-e2e="select_video_container"]').one();

/** 录制观察：自动内容检查弹窗 → Turn on */
const dialogTurnOnPath = nodePath().pText('Turn on', 'button').one();
/** 录制观察：新编辑功能弹窗 → Got it */
const dialogGotItPath = nodePath().pText('Got it', 'button').one();
/** 现场观察：版权检查未完成时 Continue to post? → Post now */
const dialogPostNowPath = nodePath().pText('Post now', 'button').one();
/** Discard 确认弹窗内的 Discard（与页底 discard_post_button 区分） */
const dialogDiscardConfirmPath = nodePath().pText('Discard', '[role="dialog"] button').one();
const copyrightContainerPath = nodePath().css('[data-e2e="copyright_container"]').one();

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

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

async function clickPath(client: XportBrowserClient, path: NodePath): Promise<boolean> {
  const [ok] = await client.clickNode(0, path);
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

/** 关闭偶发引导/确认弹窗（仅点已观察英文按钮）。 */
async function dismissTransientDialogs(client: XportBrowserClient): Promise<void> {
  for (let i = 0; i < 5; i++) {
    let acted = false;
    if ((await countOf(client, dialogTurnOnPath)) >= 1) {
      await clickPath(client, dialogTurnOnPath);
      await pause();
      acted = true;
    }
    if ((await countOf(client, dialogGotItPath)) >= 1) {
      await clickPath(client, dialogGotItPath);
      await pause();
      acted = true;
    }
    if ((await countOf(client, dialogPostNowPath)) >= 1) {
      await clickPath(client, dialogPostNowPath);
      await pause(1200);
      acted = true;
    }
    if (!acted) break;
  }
}

/** 尽量等版权/内容检查出结果，超时仍继续发（后续可点 Post now）。 */
async function waitChecksSettled(client: XportBrowserClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissTransientDialogs(client);
    if ((await countOf(client, copyrightContainerPath)) >= 1) {
      const [ok, , data] = await client.getNodeData(0, copyrightContainerPath, ['text']);
      const t = (ok && data?.text?.[0]) || '';
      if (/No issues found/i.test(t) || /issues found/i.test(t)) {
        return;
      }
    }
    if ((await countOf(client, postBtnPath)) >= 1) {
      // Post 可点且已等一段时间即可
      if (Date.now() + 1000 > deadline) return;
    }
    await Bun.sleep(700);
  }
}

/** 未保存草稿横幅：有 Discard 按钮时丢弃，避免挡住新上传。 */
async function discardUnsavedBannerIfAny(client: XportBrowserClient): Promise<void> {
  // 横幅内 Discard（非 role=dialog）；用页内文案按钮兜底
  const bannerDiscard = nodePath().pText('Discard', 'button').one();
  const unsavedHint = nodePath().pText("wasn't saved", 'body').one();
  if ((await countOf(client, unsavedHint)) < 1) return;
  if ((await countOf(client, bannerDiscard)) >= 1) {
    await clickPath(client, bannerDiscard);
    await pause();
    if ((await countOf(client, dialogDiscardConfirmPath)) >= 1) {
      await clickPath(client, dialogDiscardConfirmPath);
      await pause(1200);
    }
  }
}

async function ensureTab(
  client: XportBrowserClient,
  mediaType: 'image' | 'video',
): Promise<boolean> {
  const tab = mediaType === 'image' ? tabPhotoPath : tabVideoPath;
  if ((await countOf(client, tab)) < 1) return false;
  // 已选中则跳过点击
  const [ok, , data] = await client.getNodeData(0, tab, ['attribute:aria-selected', 'attribute:data-state']);
  const selected =
    ok &&
    (data?.['attribute:aria-selected']?.[0] === 'true' ||
      data?.['attribute:data-state']?.[0] === 'active');
  if (selected) return true;
  return clickPath(client, tab);
}

async function waitUploaded(client: XportBrowserClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissTransientDialogs(client);
    if ((await countOf(client, captionPath)) < 1) {
      await Bun.sleep(600);
      continue;
    }
    // 进入编辑页 URL（视频/图文）即已过上传选择区
    const [urlOk, , url] = await client.getPageUrl();
    if (urlOk && url && /tiktokstudio\/upload\/post\//i.test(url)) {
      return true;
    }
    // 视频：upload_status_container 含 Uploaded
    if ((await countOf(client, uploadStatusPath)) >= 1) {
      const [ok, , text] = await client.getNodeData(0, uploadStatusPath, ['text']);
      const t = (ok && text?.text?.[0]) || '';
      if (/Uploaded/i.test(t)) {
        return true;
      }
    }
    // 图文：Photos 区 "N photo(s) uploaded"
    if ((await countOf(client, photoUploadedPath)) >= 1) {
      return true;
    }
    if ((await countOf(client, postBtnPath)) >= 1) {
      return true;
    }
    await Bun.sleep(600);
  }
  return false;
}

async function waitPostSuccess(client: XportBrowserClient, timeoutMs: number): Promise<boolean> {
  const publishedToast = nodePath().pText('Video published').one();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await dismissTransientDialogs(client);
    if ((await countOf(client, publishedToast)) >= 1) {
      return true;
    }
    const [urlOk, , url] = await client.getPageUrl();
    // 现场：发布成功后跳转 tiktokstudio/content
    if (urlOk && url && /tiktokstudio\/content/i.test(url)) {
      return true;
    }
    if (urlOk && url && !/tiktokstudio\/upload/i.test(url) && /tiktok\.com/i.test(url)) {
      return true;
    }
    // 回到选择上传区视为发布流程结束（Studio 常见）
    if (
      (await countOf(client, selectVideoContainerPath)) >= 1 &&
      (await countOf(client, captionPath)) < 1
    ) {
      return true;
    }
    await Bun.sleep(700);
  }
  return false;
}

async function runAutomation(
  client: XportBrowserClient,
  taskConfig: TaskRunConfig,
): Promise<AutomationRunResult> {
  const mediaType = taskConfig.media_type === 'image' ? 'image' : 'video';
  const content = (taskConfig.content ?? '').toString();
  const images = normalizeResources(taskConfig.images);
  const video = (taskConfig.video ?? '').toString().trim();
  const mediaList = mediaType === 'image' ? images : video ? [video] : [];

  client.taskLog(
    `media_type=${mediaType} mediaCount=${mediaList.length} captionLen=${content.length}`,
  );

  if (mediaList.length === 0) {
    return automationFailWithContext(
      mediaType === 'image' ? '请选择要发布的图片' : '请选择要发布的视频',
      { code: 'UNKNOWN', step: 'validate_media' },
    );
  }

  try {
    const entryUrl = mediaType === 'image' ? UPLOAD_URL_PHOTO : UPLOAD_URL_VIDEO;
    const [goOk, goMsg] = await client.pageGoTo(0, { url: entryUrl, timeoutMs: 60_000 });
    if (!goOk) {
      return await failStep(client, 'open_upload', goMsg || '打开 TikTok Studio 上传页失败', 'NAV_FAILED', {
        entryUrl,
      });
    }
    await pause(1200);

    const [urlOk, , pageUrl] = await client.getPageUrl();
    if (urlOk && /\/login/i.test(pageUrl || '')) {
      return await failStep(client, 'check_login', '浏览器未登录 TikTok，请先登录后再跑', 'NOT_LOGGED_IN');
    }

    await discardUnsavedBannerIfAny(client);
    await dismissTransientDialogs(client);

    // Studio 首屏常有加载动画，先等到上传区/file input 出现再切 Tab
    const landingReady =
      (await waitForCount(client, fileInputPath, 1, 45_000)) ||
      (await waitForCount(client, selectVideoContainerPath, 1, 5_000)) ||
      (await waitForCount(client, tabVideoPath, 1, 5_000)) ||
      (await waitForCount(client, tabPhotoPath, 1, 5_000));
    if (!landingReady) {
      return await failStep(client, 'wait_upload_landing', '上传页加载超时', 'TIMEOUT');
    }
    await pause();

    if (!(await ensureTab(client, mediaType))) {
      // URL 已带 tab=video/photo 时，偶发 Tab 节点晚于 file input；accept 匹配则可继续
      const [accOk, , acc] = await client.getNodeData(0, fileInputPath, ['attribute:accept']);
      const accept = (accOk && acc?.['attribute:accept']?.[0]) || '';
      const acceptOk =
        mediaType === 'image'
          ? /image\//i.test(accept)
          : /video\//i.test(accept) || accept === '';
      if (!acceptOk || (await countOf(client, fileInputPath)) < 1) {
        return await failStep(
          client,
          'select_tab',
          mediaType === 'image' ? '找不到 Photos 上传 Tab' : '找不到 Videos 上传 Tab',
          'ELEMENT_NOT_FOUND',
        );
      }
      client.taskLog(`select_tab skipped; file accept=${accept || '(empty)'}`);
    }
    await pause();

    if (!(await waitForCount(client, fileInputPath, 1, 15_000))) {
      return await failStep(client, 'wait_file_input', '找不到文件上传控件', 'ELEMENT_NOT_FOUND');
    }

    if (mediaType === 'image' && mediaList.length > 1) {
      const [upOk, upMsg] = await client.uploadFiles(0, fileInputPath, mediaList);
      if (!upOk) {
        return await failStep(client, 'upload_media', upMsg || '上传图片失败', 'UNKNOWN', {
          mediaCount: String(mediaList.length),
        });
      }
    } else {
      const [upOk, upMsg] = await client.uploadFile(0, fileInputPath, mediaList[0]!);
      if (!upOk) {
        return await failStep(client, 'upload_media', upMsg || '上传媒体失败', 'UNKNOWN', {
          media: mediaList[0]!,
        });
      }
    }
    await pause(1500);

    if (!(await waitUploaded(client, 180_000))) {
      return await failStep(client, 'wait_uploaded', '等待上传完成超时', 'TIMEOUT');
    }
    await pause();
    await dismissTransientDialogs(client);

    if ((await countOf(client, captionPath)) < 1) {
      return await failStep(client, 'find_caption', '找不到描述输入框', 'ELEMENT_NOT_FOUND');
    }

    if (content.trim()) {
      const [typeOk, typeMsg] = await client.typeInNode(0, captionPath, content);
      if (!typeOk) {
        return await failStep(client, 'type_caption', typeMsg || '输入文案失败', 'UNKNOWN');
      }
      await pause();
    }

    await waitChecksSettled(client, 20_000);
    await pause();

    // 录制：可连续点 Post 直到任务完成；现场可能弹出 Post now 确认
    let posted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await dismissTransientDialogs(client);
      if ((await countOf(client, postBtnPath)) >= 1) {
        if (await clickPath(client, postBtnPath)) {
          posted = true;
          await pause(1200);
          await dismissTransientDialogs(client);
        }
      }
      if (await waitPostSuccess(client, 10_000)) {
        const [, , finalUrl] = await client.getPageUrl();
        return {
          succ: true,
          msg: 'posted',
          data: {
            mediaType,
            content,
            mediaCount: String(mediaList.length),
            finalUrl: finalUrl || '',
          },
        };
      }
      await pause(800);
    }

    if (!posted) {
      return await failStep(client, 'click_post', '找不到可点击的 Post 按钮', 'ELEMENT_NOT_FOUND');
    }

    return await failStep(client, 'confirm_posted', '已点击 Post，但未确认发布完成', 'TIMEOUT');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await failStep(client, 'unexpected', reason, 'UNKNOWN');
  }
}

const manifest = await loadAutomationManifest();
const taskConfig = await loadTaskRunConfig<TaskRunConfig>(manifest);

process.exit(await XportBrowserClient.run((client) => runAutomation(client, taskConfig)));
