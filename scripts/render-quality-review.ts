import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonObject = Record<string, any>;
type Condition = 'off' | 'near_field';
type ReviewCase = { id: string; repetitions: number };
const CONDITIONS: Condition[] = ['off', 'near_field'];
const JSON_LIMIT = 2 * 1024 * 1024;
const AUDIO_LIMIT = 12 * 1024 * 1024;
const TEXT_LIMIT = 12000;

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : 'QUALITY_REVIEW_FAILED';
}

/** Private material is rendered as text only, never inserted as HTML or JS. */
export function escapeReviewText(value: unknown, limit = TEXT_LIMIT): string {
  const text = typeof value === 'string' ? value : '';
  const shortened = text.length > limit;
  return (
    text.slice(0, limit).replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    ) + (shortened ? '…［展示已截断；完整内容见本机结果文件］' : '')
  );
}

function below(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return (
    Boolean(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${sep}`) &&
    !isAbsolute(suffix)
  );
}

function checkAncestors(root: string, candidate: string): void {
  if (candidate !== root && !below(root, candidate))
    throw new Error('PATH_OUTSIDE_PRIVATE_ROOT');
  let current = root;
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error('SYMLINK_OR_JUNCTION_NOT_ALLOWED');
    if (realpathSync(current).toLowerCase() !== current.toLowerCase())
      throw new Error('REDIRECTED_PATH_NOT_ALLOWED');
  }
}

function readJson(
  root: string,
  name: string,
  required = true,
): JsonObject | null {
  const path = resolve(root, name);
  checkAncestors(root, path);
  if (!existsSync(path)) {
    if (required) throw new Error('REQUIRED_RESULT_JSON_MISSING');
    return null;
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > JSON_LIMIT)
    throw new Error('RESULT_JSON_TOO_LARGE_OR_NOT_FILE');
  const bytes = readFileSync(path);
  if (bytes.length > JSON_LIMIT || bytes.length !== stat.size)
    throw new Error('RESULT_JSON_CHANGED_OR_TOO_LARGE');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('INVALID_RESULT_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_RESULT_JSON');
  return value as JsonObject;
}

function casesFromSummary(summary: JsonObject): ReviewCase[] {
  if (
    summary.version !== 'continuous-quality-results/1' ||
    !['synthetic', 'human'].includes(summary.kind) ||
    !Array.isArray(summary.cases) ||
    !summary.cases.length ||
    summary.cases.length > 14
  )
    throw new Error('INVALID_MATRIX_SUMMARY');
  const seen = new Set<string>();
  return summary.cases.map((item: JsonObject) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(item.id) ||
      seen.has(item.id) ||
      !Array.isArray(item.conditions) ||
      item.conditions.length !== 2
    )
      throw new Error('INVALID_REVIEW_CASE');
    seen.add(item.id);
    const counts = CONDITIONS.map((condition) => {
      const matches = item.conditions.filter(
        (entry: JsonObject) => entry?.condition === condition,
      );
      if (
        matches.length !== 1 ||
        !Number.isInteger(matches[0].expectedRuns) ||
        matches[0].expectedRuns < 1 ||
        matches[0].expectedRuns > 3
      )
        throw new Error('INVALID_REPETITION_COUNT');
      return matches[0].expectedRuns;
    });
    if (counts[0] !== counts[1])
      throw new Error('UNEQUAL_CONDITION_REPETITIONS');
    return { id: item.id, repetitions: counts[0] };
  });
}

function audioControl(
  root: string,
  runId: string,
  file: string,
  label: string,
): string {
  const path = resolve(root, runId, file);
  try {
    checkAncestors(root, path);
    if (!existsSync(path)) return `<p class="missing">${label}：未留存</p>`;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 44 || stat.size > AUDIO_LIMIT)
      throw new Error('INVALID_AUDIO_FILE_SIZE');
    return `<label class="audio-label">${label}<audio controls preload="none" src="./${encodeURIComponent(runId)}/${file}"></audio></label>`;
  } catch (error) {
    return `<p class="missing">${label}：拒绝读取（${escapeReviewText(safeError(error))}）</p>`;
  }
}

function numberLabel(value: unknown, suffix = ' ms'): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10}${suffix}`
    : '未测';
}

function renderRun(
  root: string,
  item: ReviewCase,
  repetition: number,
  condition: Condition,
) {
  const runId = `${item.id}-r${repetition}-${condition}`;
  let report: JsonObject | null;
  try {
    report = readJson(root, `${runId}/result.private.json`, false);
    if (!report)
      return {
        html: '<p class="missing">未完成／无结果文件。本项未测，不计为通过。</p>',
        completed: false,
        missing: true,
      };
    if (
      report.id !== runId ||
      report.caseId !== item.id ||
      report.repetition !== repetition ||
      report.condition !== condition ||
      typeof report.completed !== 'boolean' ||
      !['local', 'remote'].includes(report.role) ||
      report.targetLanguage !== (report.role === 'local' ? 'en' : 'zh')
    )
      throw new Error('RESULT_ID_OR_DIRECTION_MISMATCH');
  } catch (error) {
    return {
      html: `<p class="missing">结果无法审阅：${escapeReviewText(safeError(error))}。不得视为通过。</p>`,
      completed: false,
      missing: true,
    };
  }
  const complete =
    report.completed === true &&
    report.failure === null &&
    report.providerDrainConfirmed === true;
  const text =
    typeof report.outputTranscript === 'string' ? report.outputTranscript : '';
  const noMeasuredEnergy =
    report.energy?.firstEnergyAtMs === null &&
    report.energy?.activeDurationMs === 0;
  return {
    completed: complete,
    missing: false,
    html: `<p class="${complete ? 'status' : 'missing'}">${complete ? '供应商流程完成，译意与声音待耳听' : `失败／不完整：${escapeReviewText(report.failure || '未确认正常排空')}`}</p>
${noMeasuredEnergy ? '<p class="missing"><b>本次未检测到明显译音能量，请优先核查源声和模型输出。</b> 这是机器阈值提示，不等于耳听判定。</p>' : ''}
<p><b>实际输出文字（仅诊断）</b></p><div class="transcript">${text ? escapeReviewText(text) : '没有留存译文文字；仍须核查实际音频。'}</div>
${audioControl(root, runId, 'input-8k.wav', '① 原始测试输入 · 8 kHz')}
${audioControl(root, runId, 'provider-24k.wav', '② 模型直接输出 · 24 kHz')}
${audioControl(root, runId, 'phone-8k.wav', '③ 电话转码后输出 · 8 kHz')}
<details><summary>机器事件与能量估计（不是耳听延迟）</summary><dl>
<dt>实际送入的音频字节数（含前后静音）</dt><dd>${numberLabel(report.sentInputBytes, ' bytes')}</dd>
<dt>供应商输出字节数</dt><dd>${numberLabel(report.rawOutputBytes, ' bytes')}</dd>
<dt>从首个输入到估计首个有能量声音</dt><dd>${numberLabel(report.estimatedFirstEnergyAfterInputStartMs)}</dd>
<dt>输入文件结束到估计最后有能量声音</dt><dd>${numberLabel(report.estimatedLastEnergyAfterSourceFileEndMs)}</dd>
<dt>排空确认</dt><dd>${report.providerDrainConfirmed === true ? '收到' : '未收到'}</dd>
<dt>本地滤波尾部补充</dt><dd>${numberLabel(report.localFilterDrainBytes, ' bytes')}</dd>
</dl><p>能量阈值和理想排队估计可能把噪声算作声音；输入文件结束不等于最后一个音节。这里没有测量电话网络、实际播放或人耳等待。完整原始事件保存在本机结果文件。</p></details>`,
  };
}

export function renderQualityReview(options: {
  input: string;
  force?: boolean;
  cwd?: string;
}) {
  const cwd = realpathSync(options.cwd ?? process.cwd());
  const privateRoot = resolve(cwd, '.runtime');
  const root = resolve(cwd, options.input);
  if (!below(privateRoot, root))
    throw new Error('INPUT_MUST_BE_INSIDE_RUNTIME');
  checkAncestors(cwd, root);
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error('RESULT_ROOT_MISSING');
  const output = resolve(root, 'review.html');
  checkAncestors(root, output);
  if (existsSync(output) && (!options.force || !statSync(output).isFile()))
    throw new Error('REVIEW_ALREADY_EXISTS_USE_FORCE');
  const summary = readJson(root, 'summary.json')!;
  const cases = casesFromSummary(summary);
  const plan = readJson(root, 'plan.private.json', false);
  let completeCount = 0;
  let missingCount = 0;
  const sections = cases
    .map((item) => {
      const fixture = Array.isArray(plan?.cases)
        ? plan!.cases.find((entry: JsonObject) => entry?.id === item.id)
        : null;
      // A partial matrix may not have a plan; derive source/expected text only from
      // the validated case's fixed result locations, never from arbitrary paths.
      let source = fixture;
      if (!source) {
        for (
          let repetition = 1;
          repetition <= item.repetitions && !source;
          repetition += 1
        ) {
          for (const condition of CONDITIONS) {
            try {
              source = readJson(
                root,
                `${item.id}-r${repetition}-${condition}/result.private.json`,
                false,
              );
            } catch {
              /* Render per-run failures below. */
            }
            if (source) break;
          }
        }
      }
      const rows = Array.from({ length: item.repetitions }, (_, index) => {
        const cells = CONDITIONS.map((condition) => {
          const run = renderRun(root, item, index + 1, condition);
          if (run.completed) completeCount += 1;
          if (run.missing) missingCount += 1;
          return `<td>${run.html}</td>`;
        }).join('');
        return `<tr><th scope="row">第 ${index + 1} 次</th>${cells}</tr>`;
      }).join('');
      return `<section id="case-${item.id}"><h2>案例 ${item.id}</h2>
<div class="reference"><p><b>源文</b>：${escapeReviewText(source?.sourceText) || '未留存；本项不可做完整语义核对。'}</p><p><b>预期译意</b>：${escapeReviewText(source?.expectedTranslation) || '未留存'}</p></div>
<table><thead><tr><th>重复</th><th>降噪关闭 · off</th><th>耳麦降噪 · near_field</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    })
    .join('');
  const total = cases.reduce((sum, item) => sum + item.repetitions * 2, 0);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src 'self' file:; connect-src 'none'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'">
<title>连续翻译降噪对照 · 本机试听</title><style>body{font:16px/1.65 system-ui,sans-serif;background:#edf2f5;color:#17313b;margin:0;padding:28px}main{max-width:1260px;margin:auto}h1{font-size:28px}section{background:white;border:1px solid #cedce3;border-radius:12px;padding:20px;margin:28px 0}nav{display:flex;flex-wrap:wrap;gap:14px}a{color:#126468}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #d8e1e6;padding:14px;vertical-align:top}th:first-child{width:64px}.reference,.transcript{white-space:pre-wrap;overflow-wrap:anywhere}.reference{background:#f1f6f6;padding:8px 16px}.audio-label{display:block;margin:16px 0 8px}audio{display:block;width:100%;margin-top:6px}.missing{color:#9a3f25}.status{color:#276668}details{font-size:14px;margin-top:18px}dt{font-weight:600}dd{margin:0 0 8px}.note{background:#fff5d9;padding:16px;border-radius:9px}@media(max-width:700px){body{padding:12px}section{padding:10px}td,th{padding:7px}th:first-child{width:36px}}</style></head><body><main>
<h1>连续翻译降噪对照 · 本机试听</h1><p>素材类型：${summary.kind === 'synthetic' ? '合成测试声音，不能代表真人收音质量' : '参与者专用测试录音'}。计划 ${total} 次；供应商流程完整 ${completeCount} 次；缺失或无法读取 ${missingCount} 次。完成次数不是准确率。</p>
<div class="note"><b>待人工验收：译意、声线、尾句完整性。</b> 按同一行左右对照，先听原声，再听模型输出，最后听电话转码输出。重点听否定、数量、姓名、日期、男女声变化以及尾句是否完整。一次只播放一个音频，避免互相干扰。字幕仅用于定位，不能代替声音验收。</div>
<p>音频按需读取；本页不含脚本、远程资源或上传功能。打开本页不会调用 API。所有内容留在本机；不要把此页面或录音提交到 GitHub。真实电话等待和 300 ms 新增等待目标均未在这里验收。</p>
<nav aria-label="案例导航">${cases.map((item) => `<a href="#case-${item.id}">${item.id}</a>`).join('')}</nav>${sections}
</main></body></html>`;
  writeFileSync(output, html, { flag: options.force ? 'w' : 'wx' });
  return {
    output,
    cases: cases.length,
    plannedRuns: total,
    completeRuns: completeCount,
    missingRuns: missingCount,
    humanReview: 'pending',
    networkUsed: false,
  };
}

function main() {
  const args = process.argv.slice(2);
  let input: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--force' && !force) force = true;
    else if (
      args[index] === '--input' &&
      !input &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    ) {
      index += 1;
      input = args[index];
    } else throw new Error('USE_INPUT_RESULT_ROOT_AND_OPTIONAL_FORCE');
  }
  if (!input) throw new Error('USE_INPUT_RESULT_ROOT_AND_OPTIONAL_FORCE');
  console.log(JSON.stringify(renderQualityReview({ input, force })));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ failure: safeError(error) }));
    process.exitCode = 1;
  }
}
