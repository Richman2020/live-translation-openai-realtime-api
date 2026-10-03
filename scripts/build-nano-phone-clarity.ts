/** Offline, local-only listening comparison. Never starts a model or a phone call. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pcm24kToPcmu, muLawToPcm16 } from '../src/solo/translation-pcm';

const RATE = 24000;
const SOURCE = '.runtime/chatterbox-nano-gpu-lab/phone-ipc-2026-09-28T01-52-40-484Z';
const FFMPEG = '.runtime/voice-clarity-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
const SENTENCES = [
  'Hello, thank you for calling.',
  'I finish work at five, so we can talk this evening.',
  'Please tell me what time is good for you.',
];
export const CLARITY_VARIANTS = [
  { id: 'A', title: '当前声音', description: '原始合成不作处理', filter: null },
  { id: 'B', title: '只放慢一点', description: '语速降低 8%，保持音高', filter: 'atempo=0.92' },
  { id: 'C', title: '轻度降噪＋放慢', description: '轻度频谱降噪，再降低 8% 语速', filter: 'afftdn=nr=6:nf=-50:tn=0:gs=5,atempo=0.92' },
] as const;
const FILTER_PADDING_MS = 250;
const CODEC_DRAIN_BYTES = 384;
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function verifySourcePcm(data: Buffer, expected: string): void {
  if (!data.length || data.length % 2) throw new Error('SOURCE_PCM_INVALID');
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(data) !== expected) throw new Error('SOURCE_HASH_MISMATCH');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Output must be a fresh immediate child of this repository's real .runtime. */
export function resolveFreshOutput(root: string, requested: string): string {
  const actualRoot = realpathSync(root);
  const runtime = realpathSync(resolve(root, '.runtime'));
  if (!inside(actualRoot, runtime)) throw new Error('RUNTIME_OUTSIDE_REPOSITORY');
  const output = resolve(root, requested);
  if (realpathSync(dirname(output)) !== runtime || !/^voice-clarity-review-[A-Za-z0-9-]+$/.test(relative(runtime, output))) {
    throw new Error('OUTPUT_PATH_NOT_ALLOWED');
  }
  if (existsSync(output)) throw new Error('OUTPUT_ALREADY_EXISTS');
  return output;
}

export function pcmStats(pcm: Buffer, sampleRate: number) {
  if (!pcm.length || pcm.length % 2) throw new Error('PCM_INVALID');
  const count = pcm.length / 2;
  const window = Math.round(sampleRate * 0.020);
  const rms: number[] = [];
  let peak = 0;
  let clipped = 0;
  let totalSquares = 0;
  let lastNonzero = -1;
  for (let start = 0; start < count; start += window) {
    let squares = 0;
    const end = Math.min(count, start + window);
    for (let index = start; index < end; index += 1) {
      const sample = pcm.readInt16LE(index * 2);
      peak = Math.max(peak, Math.abs(sample));
      if (sample === -32768 || sample === 32767) clipped += 1;
      if (sample !== 0) lastNonzero = index;
      squares += sample * sample;
    }
    totalSquares += squares;
    rms.push(Math.sqrt(squares / (end - start)));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)];
  return {
    sampleRate, samples: count, durationMs: count * 1000 / sampleRate,
    peakAbsPcm16: peak, peakDbfs: peak ? 20 * Math.log10(peak / 32768) : null,
    clippedSamples: clipped, clippingFraction: clipped / count,
    rmsPcm16: Math.sqrt(totalSquares / count),
    rms20ms: { windows: rms.length, p00: percentile(0), p10: percentile(.1), p50: percentile(.5), p90: percentile(.9), p100: percentile(1), unit: 'PCM16 amplitude; quiet frames are not a measured noise floor' },
    exactZeroTailMs: (count - lastNonzero - 1) * 1000 / sampleRate,
  };
}

export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Matches continuous-translation-bridge.ts: fresh converter per generated waveform, 8 ms zero drain. */
export function actualPhoneCodec(pcm: Buffer) {
  const converter = new Pcm24kToPcmu();
  const pcmu = Buffer.concat([converter.push(pcm), converter.push(Buffer.alloc(CODEC_DRAIN_BYTES))]);
  const decoded = Buffer.alloc(pcmu.length * 2);
  pcmu.forEach((code, index) => decoded.writeInt16LE(muLawToPcm16(code), index * 2));
  return { pcmu, decoded };
}

export function validateFilteredPcm(data: Buffer, sourceSamples: number) {
  if (!data.length || data.length % 2) throw new Error('FILTER_OUTPUT_INVALID');
  // Guard catastrophic loss/duplication. Exact speech completeness still requires listening.
  const expectedSamples = (sourceSamples + RATE * FILTER_PADDING_MS / 1000) / .92;
  const differenceMs = (data.length / 2 - expectedSamples) * 1000 / RATE;
  if (Math.abs(differenceMs) > 100) throw new Error('FILTER_DURATION_OUT_OF_RANGE');
  return { expectedSamples, actualSamples: data.length / 2, differenceMs, tempoOnlyExpectedDurationMs: sourceSamples * 1000 / RATE / .92, addedDurationBeyondTempoOnlyMs: (data.length / 2 - sourceSamples / .92) * 1000 / RATE, speechCompleteness: 'PENDING_HUMAN_LISTENING' };
}

type SourceInput = { id: string; file: string; pcm: Buffer; sha256: string; text: string };
function loadInputs(root: string) {
  const actualRoot = realpathSync(root);
  const sourceDir = realpathSync(resolve(root, SOURCE));
  if (!inside(actualRoot, sourceDir)) throw new Error('SOURCE_OUTSIDE_REPOSITORY');
  const reportFile = resolve(sourceDir, 'report.private.json');
  const reportBytes = readFileSync(reportFile);
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (report.schema !== 'nano-phone-ipc/1' || report.status !== 'passed') throw new Error('SOURCE_REPORT_NOT_PASSED');
  const whole = report.samples?.find((sample: { id: string }) => sample.id === 'whole');
  if (!whole || report.paced?.length !== 3) throw new Error('SOURCE_MANIFEST_INVALID');
  const descriptors = [
    { id: 'whole', file: 'three-sentences-24k.pcm', sha256: whole.pcmSha256, text: SENTENCES.join(' ') },
    ...SENTENCES.map((text, index) => ({ id: `phrase-${index}`, file: `phrase-${index}-24k.pcm`, sha256: report.paced[index].pcmSha256, text })),
  ];
  const inputs: SourceInput[] = descriptors.map((item) => {
    const file = realpathSync(resolve(sourceDir, item.file));
    if (!inside(sourceDir, file)) throw new Error('SOURCE_FILE_OUTSIDE_DIRECTORY');
    const pcm = readFileSync(file);
    verifySourcePcm(pcm, item.sha256);
    return { ...item, file: relative(root, file).replaceAll('\\', '/'), pcm };
  });
  return { inputs, reportSha256: sha256(reportBytes) };
}

function filterPcm(ffmpeg: string, pcm: Buffer, filter: string) {
  const padded = Buffer.concat([pcm, Buffer.alloc(RATE * 2 * FILTER_PADDING_MS / 1000)]);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-af', filter, '-f', 's16le', '-ar', String(RATE), '-ac', '1', 'pipe:1'];
  const began = performance.now();
  const result = spawnSync(ffmpeg, args, { input: padded, timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const processingMs = performance.now() - began;
  if (result.error || result.status !== 0) throw new Error('FFMPEG_FILTER_FAILED');
  const durationCheck = validateFilteredPcm(result.stdout, pcm.length / 2);
  return { pcm: result.stdout, processingMs, durationCheck, paddedInputSha256: sha256(padded), args };
}

function saveAudio(output: string, name: string, pcm24: Buffer, pcmu: Buffer, decoded: Buffer) {
  const artifacts = [
    { kind: 'native24kWav', file: `${name}-native-24k.wav`, bytes: wav(pcm24, RATE) },
    { kind: 'phone8kWav', file: `${name}-phone-8k.wav`, bytes: wav(decoded, 8000) },
    { kind: 'rawPcmu', file: `${name}-phone.pcmu`, bytes: pcmu },
  ];
  const files = Object.fromEntries(artifacts.map((artifact) => {
    writeFileSync(resolve(output, artifact.file), artifact.bytes, { flag: 'wx' });
    return [artifact.kind, { file: artifact.file, sha256: sha256(artifact.bytes), bytes: artifact.bytes.length }];
  }));
  return { files, nativePcmSha256: sha256(pcm24), phonePcmuSha256: sha256(pcmu), decodedPcmSha256: sha256(decoded), native: pcmStats(pcm24, RATE), phone: pcmStats(decoded, 8000) };
}

function escapeHtml(value: unknown) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function html(groups: Array<{ id: string; title: string; note: string; variants: Array<any> }>) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>英文声线 · 清晰度试听</title>
<style>:root{color-scheme:light;--ink:#183235;--muted:#587072;--line:#dce5e2;--accent:#096c61}*{box-sizing:border-box}body{margin:0;background:#f4f6f2;color:var(--ink);font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1100px;margin:auto;padding:42px 28px 70px}small,.eyebrow{color:var(--accent);font-weight:700}.eyebrow{letter-spacing:.13em;font-size:12px}h1{font-size:34px;line-height:1.3;margin:10px 0 14px}h2{font-size:23px;margin:0 0 7px}p{margin:8px 0;color:var(--muted)}.intro{max-width:860px}.badge{display:inline-block;border:1px solid #bcd5cb;border-radius:30px;padding:4px 12px;font-size:13px;background:#e9f3ed;margin:10px 4px 10px 0}.script{background:#173b39;color:#fff;border-radius:14px;padding:20px 24px;margin:25px 0}.script p{color:#e1eeea;font-size:18px}.group{margin-top:36px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px;margin-top:16px}.card{background:#fff;border:1px solid var(--line);border-radius:15px;padding:20px;box-shadow:0 4px 16px #173b3905}.letter{display:inline-grid;place-items:center;border-radius:8px;width:32px;height:32px;background:#e6f1eb;font-weight:800;color:var(--accent)}h3{font-size:18px;margin:12px 0 4px}.desc{font-size:14px;min-height:46px}audio{width:100%;height:42px;margin:12px 0 5px}.metric{font-size:13px;color:var(--muted)}details{border-top:1px solid var(--line);margin-top:15px;padding-top:10px;font-size:13px}summary{cursor:pointer;color:var(--accent)}.note{margin-top:28px;background:#e9ede6;border-left:3px solid #81977d;padding:17px 21px;border-radius:0 10px 10px 0}.note p{font-size:14px}.footer{font-size:13px;margin-top:28px}a{color:var(--accent)}@media(max-width:800px){.cards{grid-template-columns:1fr}main{padding:26px 18px}.desc{min-height:0}h1{font-size:29px}}</style>
<main><div class="eyebrow">LOCAL VOICE LAB / 01</div><h1>先听清楚，再决定怎么改</h1><p class="intro">同一份已经生成的本人英文，比较轻微放慢和轻度降噪。优先听「电话编码版」，判断齿音、吞字、杂音感与句尾是否完整。</p><span class="badge">仅本机试听</span><span class="badge">未改电话版本</span><span class="badge">等待本人判断</span>
<div class="script"><small style="color:#a8d9c6">三句固定内容</small><p>${escapeHtml(SENTENCES.join(' '))}</p><div>你好，谢谢你来电。我五点下班，所以我们可以今晚聊。请告诉我你什么时间方便。</div></div>
${groups.map((group) => `<section class="group"><h2>${escapeHtml(group.title)}</h2><p>${escapeHtml(group.note)}</p><div class="cards">${group.variants.map((item) => `<article class="card"><span class="letter">${item.id}</span><h3>${escapeHtml(item.title)}</h3><p class="desc">${escapeHtml(item.description)}</p><strong>电话编码版 · 8 kHz</strong><audio controls preload="metadata" src="${item.files.phone8kWav.file}"></audio><div class="metric">总长度 ${(item.phone.durationMs / 1000).toFixed(2)} 秒 · 包含保留的尾静音</div><details><summary>展开：原生 24 kHz 对照</summary><p>用来比较电话编码前后；不是实际电话录音。</p><audio controls preload="metadata" src="${item.files.native24kWav.file}"></audio><div class="metric">处理用时 ${Math.round(item.processingMs)} ms；不等于实时新增等待。</div></details></article>`).join('')}</div></section>`).join('')}
<div class="note"><strong>怎么听</strong><p>先 A → B，判断轻微放慢是否让单词更清楚；再 B → C，判断降噪是否有帮助，或是否让辅音变薄、出现水声。一次只播放一段，不改变播放器速率。</p><p>B / C 每个合成片段处理前补 250 ms 静音，处理后保留，不截尾、不淡出；电话编码另按现用代码补 8 ms。第二组分别处理每个片段再拼接，因此片段之间会保留额外停顿。长度增加同时来自放慢和尾静音，不能全部算作语速变化。</p><p>没有重新合成、调音高、增益归一化、噪声门或水印移除。统计只能检查数值与时长，不能证明英语发音、自然度、杂音改善或水印检测结果。真实通话、实时处理等待和句尾完整性仍待验证。</p></div>
<p class="footer"><a href="report.private.json">本机处理证据</a> · A 保持源 PCM 不变；B/C 为离线候选。当前通话工具继续使用原版本。</p></main><script>document.querySelectorAll('audio').forEach(current=>current.addEventListener('play',()=>{document.querySelectorAll('audio').forEach(other=>{if(other!==current)other.pause()})}));</script></html>`;
}

export async function buildClarityReview(root = process.cwd(), requested?: string) {
  const { inputs, reportSha256 } = loadInputs(root);
  const output = resolveFreshOutput(root, requested || `.runtime/voice-clarity-review-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const ffmpeg = realpathSync(resolve(root, FFMPEG));
  if (!inside(realpathSync(root), ffmpeg)) throw new Error('FFMPEG_OUTSIDE_REPOSITORY');
  const ffmpegVersion = spawnSync(ffmpeg, ['-version'], { timeout: 10000, encoding: 'utf8', windowsHide: true });
  if (ffmpegVersion.error || ffmpegVersion.status !== 0) throw new Error('FFMPEG_NOT_READY');
  const report: any = {
    schema: 'nano-phone-clarity/1', status: 'running', createdAt: new Date().toISOString(), actualPhone: false, humanListening: 'PENDING',
    sourceReport: { file: `${SOURCE}/report.private.json`, sha256: reportSha256 },
    implementation: {
      scriptSha256: sha256(readFileSync(resolve(root, 'scripts/build-nano-phone-clarity.ts'))),
      codecSha256: sha256(readFileSync(resolve(root, 'src/solo/translation-pcm.ts'))),
      liveBridgeSha256: sha256(readFileSync(resolve(root, 'src/solo/continuous-translation-bridge.ts'))),
      ffmpeg: { file: FFMPEG, sha256: sha256(readFileSync(ffmpeg)), version: ffmpegVersion.stdout.split(/\r?\n/)[0] },
    },
    boundary: { newSynthesis: false, modelOrGpuStarted: false, networkOrApi: false, phoneChanged: false, watermarkRemoval: false, watermarkSurvivalTested: false, tempoFactor: .92, pitchPreservingAlgorithm: 'FFmpeg atempo', addedTempoPlaybackDurationRatio: 1 / .92 },
    tailHandling: { deployment: 'OFFLINE_ONLY: retained padded silence is not suitable for live adoption without separate validation', processedOnly: 'Append 250 ms PCM16 zeros before filters; retain complete FFmpeg output including trailing silence. No theoretical-duration cropping because waveform alignment and atempo EOF integrity are not established.', filterPaddingMs: FILTER_PADDING_MS, croppedSamples: 0, trim: false, fade: false, normalize: false, gate: false, codecDrainMsPerIndependentWaveform: 8, codecDrainBytes: CODEC_DRAIN_BYTES, codec: 'Actual Pcm24kToPcmu and muLawToPcm16 from src/solo/translation-pcm.ts', sentenceJoins: 'Filter each generated phrase independently, then codec+8ms drain independently, then concatenate with no inserted schedule gaps' },
    sources: inputs.map(({ pcm, ...input }) => ({ ...input, metrics: pcmStats(pcm, RATE) })),
    samples: [], groups: [],
  };
  mkdirSync(output);
  const saveReport = () => writeFileSync(resolve(output, 'report.private.json'), JSON.stringify(report, null, 2));
  saveReport();
  try {
    const cache = new Map<string, { pcm: Buffer; pcmu: Buffer; decoded: Buffer; evidence: any }>();
    for (const input of inputs) {
      for (const variant of CLARITY_VARIANTS) {
        const filtered = variant.filter ? filterPcm(ffmpeg, input.pcm, variant.filter) : { pcm: input.pcm, processingMs: 0, durationCheck: null, paddedInputSha256: null, args: null };
        const codecBegan = performance.now();
        const coded = actualPhoneCodec(filtered.pcm);
        const codecMs = performance.now() - codecBegan;
        const evidence = { source: input.id, ...variant, durationDeltaMs: (filtered.pcm.length - input.pcm.length) * 1000 / (RATE * 2), extraTailBeyondTempoMs: filtered.durationCheck?.addedDurationBeyondTempoOnlyMs || 0, processingMs: filtered.processingMs, codecMs, durationCheck: filtered.durationCheck, paddedInputSha256: filtered.paddedInputSha256, ffmpegArgs: filtered.args, ...saveAudio(output, `${input.id}-${variant.id}`, filtered.pcm, coded.pcmu, coded.decoded) };
        report.samples.push(evidence);
        cache.set(`${input.id}-${variant.id}`, { pcm: filtered.pcm, ...coded, evidence });
      }
    }
    report.groups.push({ id: 'whole', title: '第一组 · 三句话整段生成', note: '同一份完整合成，比较整体连贯性。', variants: CLARITY_VARIANTS.map((variant) => cache.get(`whole-${variant.id}`)!.evidence) });
    const joined: any[] = [];
    for (const variant of CLARITY_VARIANTS) {
      const parts = [0, 1, 2].map((index) => cache.get(`phrase-${index}-${variant.id}`)!);
      const pcm = Buffer.concat(parts.map((part) => part.pcm));
      const pcmu = Buffer.concat(parts.map((part) => part.pcmu));
      const decoded = Buffer.concat(parts.map((part) => part.decoded));
      joined.push({ ...variant, source: 'separately-generated-phrases', partSourceIds: ['phrase-0', 'phrase-1', 'phrase-2'], paddingInputMsTotal: variant.filter ? FILTER_PADDING_MS * parts.length : 0, durationDeltaMs: parts.reduce((total, part) => total + part.evidence.durationDeltaMs, 0), extraTailBeyondTempoMs: parts.reduce((total, part) => total + part.evidence.extraTailBeyondTempoMs, 0), processingMs: parts.reduce((total, part) => total + part.evidence.processingMs, 0), codecMs: parts.reduce((total, part) => total + part.evidence.codecMs, 0), ...saveAudio(output, `joined-${variant.id}`, pcm, pcmu, decoded) });
    }
    report.groups.push({ id: 'joined', title: '第二组 · 按三句分别生成后接起来', note: '更接近当前电话逐句输出方式；每句独立处理、独立电话编码，再拼接。这里不模拟网络、合成排队或真实接听。', variants: joined });
    report.status = 'generated_for_listening';
    saveReport();
    writeFileSync(resolve(output, 'index.html'), html(report.groups), { flag: 'wx' });
    return { output, status: report.status, actualPhone: false, humanListening: 'PENDING' };
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof Error ? error.message : 'BUILD_FAILED'; saveReport(); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) throw new Error('USAGE: node --import tsx scripts/build-nano-phone-clarity.ts [--out .runtime/voice-clarity-review-name]');
  buildClarityReview(process.cwd(), args[1]).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error instanceof Error ? error.message : 'BUILD_FAILED'); process.exitCode = 1; });
}
