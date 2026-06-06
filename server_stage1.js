const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const TEXT_TMP_DIR = path.join(os.tmpdir(), "video-tool-text");
const FILTER_WORK_ROOT = path.join(os.tmpdir(), "video-tool-work");

const MAX_CONCURRENT_JOBS = 2;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_PRESETS = new Set([
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow",
]);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(TEXT_TMP_DIR)) fs.mkdirSync(TEXT_TMP_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const jobs = new Map();
let activeFfmpegJobs = 0;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const FONTS_DIR = path.join(__dirname, "fonts");
const RUNTIME_FONTS_DIR = path.join(os.tmpdir(), "video-tool-fonts");

const BUNDLED_FONTS = [
  { src: "BeVietnamPro-ExtraBold.ttf", key: "title" },
  { src: "BeVietnamPro-Bold.ttf", key: "subtitle" },
  { src: "BeVietnamPro-Bold.ttf", key: "badge" },
];

function initRuntimeFonts() {
  try {
    if (!fs.existsSync(RUNTIME_FONTS_DIR)) fs.mkdirSync(RUNTIME_FONTS_DIR, { recursive: true });
    for (const { src } of BUNDLED_FONTS) {
      const from = path.join(FONTS_DIR, src);
      const to = path.join(RUNTIME_FONTS_DIR, src);
      if (fs.existsSync(from)) {
        const stFrom = fs.statSync(from);
        if (!fs.existsSync(to) || fs.statSync(to).mtimeMs < stFrom.mtimeMs) {
          fs.copyFileSync(from, to);
        }
      }
    }
  } catch (err) {
    console.warn("Không copy được font vào thư mục tạm:", err.message);
  }
}

initRuntimeFonts();

function runtimeFont(name) {
  return path.join(RUNTIME_FONTS_DIR, name);
}

const DEFAULT_FONT_CANDIDATES = [
  runtimeFont("BeVietnamPro-Bold.ttf"),
  path.join(FONTS_DIR, "BeVietnamPro-Bold.ttf"),
  "C:\\Windows\\Fonts\\segoeui.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];

const FONT_TITLE_CANDIDATES = [
  runtimeFont("BeVietnamPro-ExtraBold.ttf"),
  path.join(FONTS_DIR, "BeVietnamPro-ExtraBold.ttf"),
  runtimeFont("BeVietnamPro-Bold.ttf"),
  "C:\\Windows\\Fonts\\arialblk.ttf",
  "C:\\Windows\\Fonts\\seguibl.ttf",
  "C:\\Windows\\Fonts\\segoeuib.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];

const FONT_SUBTITLE_CANDIDATES = [
  runtimeFont("BeVietnamPro-Bold.ttf"),
  path.join(FONTS_DIR, "BeVietnamPro-Bold.ttf"),
  runtimeFont("BeVietnamPro-ExtraBold.ttf"),
  "C:\\Windows\\Fonts\\segoeuib.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
];

const FONT_BOLD_CANDIDATES = FONT_TITLE_CANDIDATES;

const FONT_BADGE_CANDIDATES = [
  runtimeFont("BeVietnamPro-Bold.ttf"),
  path.join(FONTS_DIR, "BeVietnamPro-Bold.ttf"),
  runtimeFont("BeVietnamPro-ExtraBold.ttf"),
  path.join(FONTS_DIR, "BeVietnamPro-ExtraBold.ttf"),
];

function pickExistingFont(candidates, fallback) {
  const found = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  return found || fallback || "";
}

const DEFAULT_FONT_FILE = DEFAULT_FONT_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

const OUTFIT_ANIM = {
  displaySec: 3.5,
  fadeIn: 0.45,
  fadeOut: 0.38,
  stagger: { badge: 0, title: 0.28, subtitle: 0.55 },
};

function buildFadeAlphaExpr(segStart, segEnd, fadeIn, fadeOut, appearDelay) {
  const s = segStart + (appearDelay || 0);
  const e = segEnd;
  const fi = Math.max(0.08, fadeIn);
  const fo = Math.max(0.08, fadeOut);
  const fadeOutStart = Math.max(s + fi, e - fo);
  return (
    `if(lt(t\\,${s})\\,0\\,` +
    `if(lt(t\\,${(s + fi).toFixed(3)})\\,(t-${s.toFixed(3)})/${fi.toFixed(3)}\\,` +
    `if(lt(t\\,${fadeOutStart.toFixed(3)})\\,1\\,` +
    `if(lt(t\\,${e.toFixed(3)})\\,(${(e).toFixed(3)}-t)/${fo.toFixed(3)}\\,0))))`
  );
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function formatHHMMSS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "00:00:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function escapeDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r/g, "")
    .replace(/\n/g, " ");
}

function getPosition(position) {
  const map = {
    center: { x: "(w-text_w)/2", y: "(h-text_h)/2" },
    top: { x: "(w-text_w)/2", y: "50" },
    bottom: { x: "(w-text_w)/2", y: "h-text_h-50" },
    "top-left": { x: "50", y: "50" },
    "top-right": { x: "w-text_w-50", y: "50" },
    "bottom-left": { x: "50", y: "h-text_h-50" },
    "bottom-right": { x: "w-text_w-50", y: "h-text_h-50" },
  };
  return map[position] || map.bottom;
}

function parseHexColor(hex, fallback = "FFFFFF") {
  const raw = String(hex || "").trim();
  const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return fallback;
  return m[1].toUpperCase();
}

function hexTo0x(hex) {
  return `0x${parseHexColor(hex)}`;
}

function escapeFontPath(p) {
  return String(p)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");
}

function escapeFilterPath(p) {
  return escapeFontPath(p);
}

function resolveDrawtextFontPath(fontPath) {
  const resolved = path.resolve(String(fontPath || "").trim());
  if (!resolved || !fs.existsSync(resolved)) return "";

  const projectRoot = path.resolve(__dirname);
  const needsCopy = resolved.includes(" ") || resolved.startsWith(projectRoot);

  if (!needsCopy) return resolved;

  if (!fs.existsSync(RUNTIME_FONTS_DIR)) fs.mkdirSync(RUNTIME_FONTS_DIR, { recursive: true });
  const runtime = path.join(RUNTIME_FONTS_DIR, path.basename(resolved));
  try {
    if (!fs.existsSync(runtime)) fs.copyFileSync(resolved, runtime);
    return runtime;
  } catch {
    return resolved;
  }
}

const DEFAULT_FONT_TITLE = resolveDrawtextFontPath(pickExistingFont(FONT_TITLE_CANDIDATES, DEFAULT_FONT_FILE))
  || pickExistingFont(FONT_TITLE_CANDIDATES, DEFAULT_FONT_FILE);
const DEFAULT_FONT_SUBTITLE = resolveDrawtextFontPath(pickExistingFont(FONT_SUBTITLE_CANDIDATES, DEFAULT_FONT_TITLE))
  || pickExistingFont(FONT_SUBTITLE_CANDIDATES, DEFAULT_FONT_TITLE);
const DEFAULT_FONT_BOLD = DEFAULT_FONT_TITLE;
const DEFAULT_FONT_BADGE = resolveDrawtextFontPath(pickExistingFont(FONT_BADGE_CANDIDATES, DEFAULT_FONT_SUBTITLE))
  || pickExistingFont(FONT_BADGE_CANDIDATES, DEFAULT_FONT_SUBTITLE);

function validateFontFile(fontFile) {
  const raw = String(fontFile || "").trim();
  if (!raw) return resolveDrawtextFontPath(DEFAULT_FONT_FILE) || DEFAULT_FONT_FILE || "";
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Không tìm thấy file font: ${raw}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".ttf", ".otf", ".ttc"].includes(ext)) {
    throw new Error("Font phải là file .ttf, .otf hoặc .ttc");
  }
  return resolveDrawtextFontPath(resolved) || resolved;
}

function validatePreset(preset) {
  const p = String(preset || "slow").toLowerCase();
  if (!ALLOWED_PRESETS.has(p)) return "slow";
  return p;
}

function validateResolution(resolution) {
  return resolution === "4k" ? "4k" : "1080p";
}

function validateAspectRatio(raw) {
  return String(raw || "").toLowerCase() === "landscape" ? "landscape" : "portrait";
}

function getTargetSize(resolution, aspectRatio) {
  const is4k = resolution === "4k";
  if (aspectRatio === "portrait") {
    return is4k ? { w: 2160, h: 3840 } : { w: 1080, h: 1920 };
  }
  return is4k ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 };
}

const SCALE_QUALITY_FLAGS = "flags=lanczos+accurate_rnd+full_chroma_int";
const ASPECT_MATCH_TOLERANCE = 0.028;

function getSourceDisplaySize(info) {
  const w = Number(info?.displayWidth || info?.width) || 0;
  const h = Number(info?.displayHeight || info?.height) || 0;
  return { w, h };
}

function isAspectRatioMatch(srcW, srcH, targetW, targetH) {
  if (srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) return false;
  const srcRatio = srcW / srcH;
  const targetRatio = targetW / targetH;
  return Math.abs(srcRatio - targetRatio) <= ASPECT_MATCH_TOLERANCE;
}

/** Scale 9:16 (hoặc cùng tỉ lệ khung đích) → upscale Lanczos, không pad. Khác tỉ lệ → scale vừa khung + viền đen. */
function buildScalePadChain(info, target) {
  const { w: srcW, h: srcH } = getSourceDisplaySize(info);
  if (isAspectRatioMatch(srcW, srcH, target.w, target.h)) {
    return `scale=${target.w}:${target.h}:${SCALE_QUALITY_FLAGS}`;
  }
  const scale = `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease:${SCALE_QUALITY_FLAGS}`;
  const pad = `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  return `${scale},${pad}`;
}

function fitOutfitAnimForClip(dur, showSec) {
  const visibleSec = Math.min(showSec, dur);
  const base = OUTFIT_ANIM;
  if (visibleSec >= showSec * 0.85) {
    return { visibleSec, fadeIn: base.fadeIn, fadeOut: base.fadeOut, stagger: base.stagger };
  }
  return {
    visibleSec,
    fadeIn: Math.min(base.fadeIn, visibleSec * 0.22),
    fadeOut: Math.min(base.fadeOut, visibleSec * 0.18),
    stagger: {
      badge: 0,
      title: visibleSec * 0.08,
      subtitle: visibleSec * 0.16,
    },
  };
}

function buildPlatformDefaults(platform) {
  const p = String(platform || "");
  if (p === "youtube-1080p60") return { resolution: "1080p", fpsMode: "60", videoBitrateMbps: 12, preset: "medium" };
  if (p === "youtube-4k60") return { resolution: "4k", fpsMode: "60", videoBitrateMbps: 40, preset: "slow" };
  if (p === "tiktok-1080p60") return { resolution: "1080p", fpsMode: "auto", videoBitrateMbps: 12, preset: "medium" };
  if (p === "tiktok-4k60") return { resolution: "4k", fpsMode: "60", videoBitrateMbps: 40, preset: "slow" };
  if (p === "facebook-1080p60") return { resolution: "1080p", fpsMode: "30", videoBitrateMbps: 10, preset: "medium" };
  return null;
}

function validateFpsMode(raw) {
  const m = String(raw || "auto").toLowerCase();
  if (m === "30" || m === "60") return m;
  return "auto";
}

function parseFfmpegFps(rateStr) {
  const s = String(rateStr || "").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) {
    const den = Number(m[2]);
    if (den > 0) return Number(m[1]) / den;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function isNearFps(value, target, tolerance) {
  return Number.isFinite(value) && Math.abs(value - target) <= tolerance;
}

/** Auto: giữ 30/60 nếu clip đồng nhất; ghép clip lệch FPS → ưu tiên 60; còn lại snap 30/60. */
function resolveOutputFps(sourceFpsList, fpsMode) {
  const mode = validateFpsMode(fpsMode);
  if (mode === "30") return 30;
  if (mode === "60") return 60;

  const src = (sourceFpsList || []).filter((f) => Number.isFinite(f) && f > 0);
  if (src.length === 0) return 30;

  const minF = Math.min(...src);
  const maxF = Math.max(...src);
  const avg = src.reduce((a, b) => a + b, 0) / src.length;

  if (maxF - minF <= 1.5) {
    if (isNearFps(avg, 59.94, 0.06) || isNearFps(avg, 60, 1.5)) return 60;
    if (isNearFps(avg, 29.97, 0.06) || isNearFps(avg, 30, 1.5)) return 30;
    return avg >= 45 ? 60 : 30;
  }

  if (maxF >= 50) return 60;
  return 30;
}

function fpsFilterValue(fps) {
  if (isNearFps(fps, 23.976, 0.02)) return "24000/1001";
  if (isNearFps(fps, 29.97, 0.02)) return "30000/1001";
  if (isNearFps(fps, 59.94, 0.02)) return "60000/1001";
  return String(Math.round(fps * 1000) / 1000);
}

function getVideoBitrateSettings(resolution, videoBitrateMbps) {
  if (resolution === "4k") {
    const mbps = clamp(Number(videoBitrateMbps) || 40, 25, 50);
    return {
      target: `${mbps}M`,
      max: `${Math.min(50, mbps + 8)}M`,
      bufsize: `${mbps * 2}M`,
    };
  }
  const mbps = clamp(Number(videoBitrateMbps) || 12, 8, 15);
  return {
    target: `${mbps}M`,
    max: `${Math.min(15, mbps + 3)}M`,
    bufsize: `${mbps * 2}M`,
  };
}

function resolveAudioSampleRate(sourceRates) {
  const rates = (sourceRates || []).filter((r) => Number.isFinite(r) && r > 0);
  if (rates.length > 0 && rates.every((r) => Math.abs(r - 44100) < 800)) return 44100;
  return 48000;
}

function addVideoEncodeArgs(args, { resolution, videoBitrateMbps, preset, fps }) {
  const br = getVideoBitrateSettings(resolution, videoBitrateMbps);
  const outFps = Number(fps) || 30;
  const level = resolution === "4k" ? "5.1" : (outFps >= 50 ? "4.2" : "4.0");
  const gop = Math.max(30, Math.round(outFps * 2));

  args.push("-c:v", "libx264");
  args.push("-preset", validatePreset(preset));
  args.push("-profile:v", "high");
  args.push("-level", level);
  args.push("-pix_fmt", "yuv420p");
  args.push("-b:v", br.target);
  args.push("-maxrate", br.max);
  args.push("-bufsize", br.bufsize);
  args.push("-g", String(gop), "-keyint_min", String(gop));
}

function addAudioEncodeArgs(args, audioSampleRate) {
  const ar = audioSampleRate === 44100 ? 44100 : 48000;
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", String(ar));
}

function normalizeOutfitSets(outfitSets, clipCount) {
  const src = Array.isArray(outfitSets) ? outfitSets : [];
  const out = [];
  for (let i = 0; i < clipCount; i++) {
    out.push(src[i] || { badge: "", title: "", subtitle: "" });
  }
  return out;
}

function getDisplayDimensions(width, height, rotation) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const rot = Math.abs(Number(rotation) || 0) % 360;
  if ((rot === 90 || rot === 270) && w > 0 && h > 0) {
    return { width: h, height: w, rotation: rot };
  }
  return { width: w, height: h, rotation: rot };
}

function getRotationTransposeFilter(rotation) {
  const rot = Math.abs(Number(rotation) || 0) % 360;
  if (rot === 90) return "transpose=1";
  if (rot === 270) return "transpose=2";
  if (rot === 180) return "hflip,vflip";
  return "";
}

function parseRotationFromStream(stream) {
  const tagRot = Number(stream?.tags?.rotate);
  if (Number.isFinite(tagRot)) return tagRot;
  const sideList = stream?.side_data_list || [];
  for (const sd of sideList) {
    if (sd.rotation != null && Number.isFinite(Number(sd.rotation))) {
      return Number(sd.rotation);
    }
  }
  return 0;
}

function ensureJobWorkDir(jobId) {
  const safeJob = String(jobId || "job").replace(/[^\w-]/g, "");
  const dir = path.join(FILTER_WORK_ROOT, safeJob);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupJobWorkDir(jobId) {
  const safeJob = String(jobId || "").replace(/[^\w-]/g, "");
  if (!safeJob) return;
  try {
    fs.rmSync(path.join(FILTER_WORK_ROOT, safeJob), { recursive: true, force: true });
  } catch {}
}

function mapFontToWorkDir(fontPathRaw, workDir, fontMap) {
  const resolved = resolveDrawtextFontPath(fontPathRaw);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`Không tìm thấy file font: ${fontPathRaw || "(trống)"}`);
  }
  if (fontMap.has(resolved)) return fontMap.get(resolved);
  const rel = `f${fontMap.size}.ttf`;
  fs.copyFileSync(resolved, path.join(workDir, rel));
  fontMap.set(resolved, rel);
  return rel;
}

function writeDrawtextTextFile(workDir, lineId, text) {
  const rel = `t${lineId}.txt`;
  fs.writeFileSync(path.join(workDir, rel), String(text ?? ""), "utf8");
  return rel;
}

function normalizeTextLine(line) {
  let start = Number(line.start ?? 0);
  let end = Number(line.end ?? 0);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end < 0) end = 0;
  if (end > 0 && start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { ...line, start, end };
}

function buildDrawtextOne(line, resolvedFontPath, textRelPath, fontRelPath) {
  const norm = normalizeTextLine(line);
  const pos = getPosition(norm.position);

  const fontsize = clamp(Number(norm.fontsize ?? 48), 8, 400);
  const opacity = clamp(Number(norm.opacity ?? 0.8), 0, 1);
  const fontColor = hexTo0x(norm.color ?? "FFFFFF");

  const borderEnabled = Boolean(norm.borderEnabled);
  const borderWidth = clamp(Number(norm.borderWidth ?? 2), 0, 30);
  const borderOpacity = clamp(Number(norm.borderOpacity ?? 0.6), 0, 1);
  const borderColor = `0x${parseHexColor(norm.borderColor, "000000")}@${borderOpacity}`;

  const shadowEnabled = Boolean(norm.shadowEnabled);
  const shadowOpacity = clamp(Number(norm.shadowOpacity ?? 0.5), 0, 1);
  const shadowColor = `0x${parseHexColor(norm.shadowColor, "000000")}@${shadowOpacity}`;
  const shadowX = Number(norm.shadowX ?? 2);
  const shadowY = Number(norm.shadowY ?? 2);

  const hasTime = norm.end > 0;
  const enableExpr = hasTime ? `between(t\\,${norm.start}\\,${norm.end})` : "1";

  const fontPathRaw = norm.fontPath || resolvedFontPath;
  if (!fontRelPath) {
    throw new Error(`Không tìm thấy file font: ${fontPathRaw || "(trống)"}`);
  }
  const x = norm.customX != null && String(norm.customX).trim() !== "" ? norm.customX : pos.x;
  const yRaw = norm.customY != null && String(norm.customY).trim() !== "" ? String(norm.customY) : pos.y;
  const y = /text_h/.test(yRaw) && !yRaw.startsWith("(") ? `(${yRaw})` : yRaw;

  const useFade = Boolean(norm.fadeEnabled) && hasTime;
  const colorPart = useFade ? fontColor : `${fontColor}@${opacity}`;

  const textPart = textRelPath
    ? `textfile=${textRelPath}`
    : `text='${escapeDrawtext(norm.text)}'`;

  const opts = [
    textPart,
    `fontfile=${fontRelPath}`,
    `fontcolor=${colorPart}`,
    `fontsize=${fontsize}`,
    `x=${x}`,
    `y=${y}`,
    `enable='${enableExpr}'`,
  ];

  if (useFade) {
    opts.push(
      `alpha='${buildFadeAlphaExpr(norm.start, norm.end, norm.fadeIn, norm.fadeOut, norm.appearDelay)}'`
    );
  }

  if (borderEnabled) {
    opts.push(`borderw=${borderWidth}`, `bordercolor=${borderColor}`);
  } else {
    opts.push("borderw=0");
  }

  if (shadowEnabled) {
    opts.push(`shadowx=${shadowX}`, `shadowy=${shadowY}`, `shadowcolor=${shadowColor}`);
  }

  return `drawtext=${opts.join(":")}`;
}

function scaleForResolution(base, resolution) {
  return resolution === "4k" ? Math.round(base * 2) : base;
}

function computeOutfitLayout(vw, vh, targetW, targetH, resolution) {
  const is4k = resolution === "4k";
  const badgeOffX = is4k ? 80 : 44;
  const badgeOffY = is4k ? 130 : 68;

  if (!vw || !vh || vw <= 0 || vh <= 0) {
    return {
      badgeX: String(badgeOffX),
      badgeY: String(badgeOffY),
      titleY: "(h*0.62-text_h/2)",
      subtitleY: "(h*0.70-text_h/2)",
    };
  }

  const scale = Math.min(targetW / vw, targetH / vh);
  const scaledH = vh * scale;
  const padY = (targetH - scaledH) / 2;
  const padX = (targetW - vw * scale) / 2;
  const titleCenter = Math.round(padY + scaledH * 0.62);
  const subtitleCenter = Math.round(padY + scaledH * 0.70);
  const badgeX = Math.round(padX + badgeOffX * (targetW / 1080));
  const badgeY = Math.round(padY + badgeOffY * (targetH / 1920));

  return {
    badgeX: String(badgeX),
    badgeY: String(badgeY),
    titleY: `(${titleCenter}-text_h/2)`,
    subtitleY: `(${subtitleCenter}-text_h/2)`,
  };
}

function buildOutfitClipTexts(outfitSets, inputInfos, resolution, userFont, displaySec, aspectRatio) {
  const fontTitle = resolveDrawtextFontPath(userFont || DEFAULT_FONT_TITLE || DEFAULT_FONT_FILE)
    || DEFAULT_FONT_TITLE || DEFAULT_FONT_FILE;
  const fontSubtitle = resolveDrawtextFontPath(DEFAULT_FONT_SUBTITLE) || fontTitle;
  const fontBadge = resolveDrawtextFontPath(DEFAULT_FONT_BADGE) || fontSubtitle;
  const perClip = [];
  const showSec = clamp(Number(displaySec) || OUTFIT_ANIM.displaySec, 1.5, 8);
  const target = getTargetSize(resolution, aspectRatio || "portrait");

  const sizes = {
    badge: scaleForResolution(62, resolution),
    title: scaleForResolution(96, resolution),
    subtitle: scaleForResolution(64, resolution),
    badgeBorder: scaleForResolution(5, resolution),
    titleBorder: scaleForResolution(12, resolution),
    subtitleBorder: scaleForResolution(8, resolution),
  };

  const titleStyle = {
    shadowEnabled: true,
    shadowX: scaleForResolution(2, resolution),
    shadowY: scaleForResolution(4, resolution),
    shadowOpacity: 0.35,
    shadowColor: "#0A1628",
  };

  const subtitleStyle = {
    shadowEnabled: true,
    shadowX: scaleForResolution(1, resolution),
    shadowY: scaleForResolution(3, resolution),
    shadowOpacity: 0.3,
    shadowColor: "#0A1628",
  };

  for (let i = 0; i < inputInfos.length; i++) {
    const info = inputInfos[i];
    const dur = Number.isFinite(info.duration) ? info.duration : 1;
    const clipAnim = fitOutfitAnimForClip(dur, showSec);
    const layout = computeOutfitLayout(
      info.displayWidth || info.width,
      info.displayHeight || info.height,
      target.w,
      target.h,
      resolution
    );

    const set = outfitSets[i] || {};
    const badge = String(set.badge ?? "").trim();
    const title = String(set.title ?? "").trim();
    const subtitle = String(set.subtitle ?? "").trim();
    const time = {
      start: 0,
      end: clipAnim.visibleSec,
      fadeEnabled: true,
      fadeIn: clipAnim.fadeIn,
      fadeOut: clipAnim.fadeOut,
    };

    const baseStyle = {
      opacity: 1,
      borderEnabled: true,
      borderColor: "#FFFFFF",
      borderOpacity: 1,
      color: "#1E3A5F",
    };

    const clipLines = [];

    if (badge) {
      clipLines.push({
        ...baseStyle,
        ...time,
        appearDelay: clipAnim.stagger.badge,
        text: badge,
        customX: layout.badgeX,
        customY: layout.badgeY,
        fontsize: sizes.badge,
        color: "#1A1A1A",
        borderWidth: sizes.badgeBorder,
        fontPath: fontBadge,
      });
    }

    if (title) {
      clipLines.push({
        ...baseStyle,
        ...titleStyle,
        ...time,
        appearDelay: clipAnim.stagger.title,
        text: title,
        customX: "(w-text_w)/2",
        customY: layout.titleY,
        fontsize: sizes.title,
        borderWidth: sizes.titleBorder,
        fontPath: fontTitle,
      });
    }

    if (subtitle) {
      clipLines.push({
        ...baseStyle,
        ...subtitleStyle,
        ...time,
        appearDelay: clipAnim.stagger.subtitle,
        text: subtitle,
        customX: "(w-text_w)/2",
        customY: layout.subtitleY,
        fontsize: sizes.subtitle,
        borderWidth: sizes.subtitleBorder,
        fontPath: fontSubtitle,
      });
    }

    perClip.push(clipLines);
  }

  return perClip;
}

/** @deprecated giữ tương thích — flatten per-clip lines */
function buildOutfitTextLines(outfitSets, inputInfos, resolution, userFont, displaySec, aspectRatio) {
  return buildOutfitClipTexts(outfitSets, inputInfos, resolution, userFont, displaySec, aspectRatio).flat();
}

function parseTextEnabled(raw) {
  if (raw === false || raw === 0) return false;
  const s = String(raw ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(s);
}

function parseOutfitSets(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("Dữ liệu outfitSets không hợp lệ (JSON lỗi).");
  }
}

function probeFileInfo(filePath) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate:stream_tags=rotate:stream_side_data=rotation",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath,
    ];
    const proc = spawn("ffprobe", args, { shell: false });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", (code) => {
      const empty = {
        duration: NaN, hasAudio: false, width: 0, height: 0,
        displayWidth: 0, displayHeight: 0, rotation: 0, fps: NaN, audioSampleRate: NaN,
      };
      if (code !== 0) return resolve(empty);
      try {
        const data = JSON.parse(out);
        const duration = Number(data.format?.duration);
        const streams = data.streams || [];
        const hasAudio = streams.some((s) => s.codec_type === "audio");
        const videoStream = streams.find((s) => s.codec_type === "video");
        const audioStream = streams.find((s) => s.codec_type === "audio");
        const width = Number(videoStream?.width) || 0;
        const height = Number(videoStream?.height) || 0;
        const rotation = parseRotationFromStream(videoStream);
        const display = getDisplayDimensions(width, height, rotation);
        const fps = parseFfmpegFps(videoStream?.avg_frame_rate) || parseFfmpegFps(videoStream?.r_frame_rate);
        const audioSampleRate = Number(audioStream?.sample_rate) || NaN;
        resolve({
          duration: Number.isFinite(duration) ? duration : NaN,
          hasAudio,
          width,
          height,
          rotation: display.rotation,
          displayWidth: display.width,
          displayHeight: display.height,
          fps,
          audioSampleRate,
        });
      } catch {
        resolve(empty);
      }
    });
    proc.on("error", () => resolve({
      duration: NaN, hasAudio: false, width: 0, height: 0,
      displayWidth: 0, displayHeight: 0, rotation: 0, fps: NaN, audioSampleRate: NaN,
    }));
  });
}

function parseProgressLine(line) {
  const idx = line.indexOf("=");
  if (idx === -1) return null;
  return { k: line.slice(0, idx).trim(), v: line.slice(idx + 1).trim() };
}

function parseStderrTime(line) {
  const m = line.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return NaN;
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4]) / 100
  );
}

function translateFfmpegError(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (s.includes("invalid argument") && s.includes("filter")) {
    return "Lỗi filter FFmpeg: kiểm tra lại nội dung chữ hoặc cấu hình chữ (ký tự đặc biệt, thời gian start/end).";
  }
  if (s.includes("fontfile") && !s.includes("filter")) {
    return "Lỗi font: đường dẫn font không hợp lệ hoặc FFmpeg không đọc được file font.";
  }
  if (s.includes("does not contain any stream") || s.includes("stream map")) {
    return "Lỗi luồng video/audio: file đầu vào có thể bị hỏng hoặc không có video hợp lệ.";
  }
  if (s.includes("no space left")) {
    return "Ổ đĩa đầy: không đủ dung lượng để xuất video.";
  }
  if (s.includes("permission denied")) {
    return "Không có quyền ghi file đầu ra. Kiểm tra quyền thư mục outputs/.";
  }
  if (s.includes("encoder") && (s.includes("libx264") || s.includes("libx265"))) {
    return "FFmpeg không hỗ trợ mã hóa H.264/H.265 trên máy này.";
  }
  return "FFmpeg báo lỗi khi xử lý. Xem chi tiết kỹ thuật bên dưới.";
}

function addMetadataArgs(args, mode) {
  args.push("-map_metadata", "-1");
  args.push("-map_metadata:s:v", "-1");
  args.push("-map_metadata:s:a", "-1");
  if (mode === "all" || mode === "sensitive") {
    args.push("-movflags", "+faststart");
  }
}

function updateJobProgress(job, curSec) {
  if (!job || !Number.isFinite(job.totalDurationSec) || job.totalDurationSec <= 0) return;
  const percent = clamp((curSec / job.totalDurationSec) * 100, 0, 100);
  job.progress = percent;
  job.lastOutTimeSec = curSec;

  const elapsedSec = (Date.now() - job.startedAt) / 1000;
  let etaSec = NaN;

  if (job.lastSpeed && job.lastSpeed > 0) {
    etaSec = (job.totalDurationSec - curSec) / job.lastSpeed;
  } else if (percent > 1) {
    etaSec = elapsedSec * (100 / percent - 1);
  }

  job.etaSeconds = Number.isFinite(etaSec) && etaSec >= 0 ? etaSec : NaN;
}

function safeOutputBaseName(originalName) {
  const ext = path.extname(String(originalName || ""));
  const base = path.basename(String(originalName || "video"), ext);
  const cleaned = base.replace(/[^\w\u00C0-\u024F.-]+/gi, "_").replace(/_+/g, "_").slice(0, 60);
  return cleaned || "video";
}

function buildUpscaleOutputName(originalName, resolution, index) {
  const tag = resolution === "4k" ? "4k" : "1080p";
  const suffix = Number.isFinite(index) ? `-${index}` : "";
  return `upscaled-${tag}-${safeOutputBaseName(originalName)}-${Date.now().toString(36)}${suffix}.mp4`;
}

function buildUpscaleFilterGraph(inputInfo, resolution, fps, aspectRatio, jobId, audioSampleRate) {
  const target = getTargetSize(resolution, aspectRatio || "portrait");
  const workDir = ensureJobWorkDir(jobId);
  const rotFilter = getRotationTransposeFilter(inputInfo.rotation);
  const scalePad = buildScalePadChain(inputInfo, target);
  const fpsVal = fpsFilterValue(fps);
  const vChain = rotFilter
    ? `[0:v]${rotFilter},${scalePad},fps=${fpsVal},format=yuv420p[vout]`
    : `[0:v]${scalePad},fps=${fpsVal},format=yuv420p[vout]`;
  const dur = Number.isFinite(inputInfo.duration) ? inputInfo.duration : 1;
  const ar = audioSampleRate || 48000;
  const aChain = inputInfo.hasAudio
    ? `[0:a]aformat=channel_layouts=stereo:sample_rates=${ar},aresample=async=1[aout]`
    : `anullsrc=channel_layout=stereo:sample_rate=${ar},atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;
  const filterScript = "filter.txt";
  fs.writeFileSync(path.join(workDir, filterScript), `${vChain};${aChain}`, "utf8");
  return { workDir, filterScript };
}

function buildFilterGraph({ inputInfos, textLines, perClipTextLines, resolvedFontPath, resolution, fps, aspectRatio, jobId, audioSampleRate }) {
  const target = getTargetSize(resolution, aspectRatio || "landscape");
  const n = inputInfos.length;
  const parts = [];
  const usePerClipText = Array.isArray(perClipTextLines);
  let textLineCounter = 0;
  const workDir = ensureJobWorkDir(jobId);
  const fontMap = new Map();
  const fpsVal = fpsFilterValue(fps);
  const ar = audioSampleRate || 48000;

  for (let i = 0; i < n; i++) {
    const rotFilter = getRotationTransposeFilter(inputInfos[i].rotation);
    const scalePad = buildScalePadChain(inputInfos[i], target);
    const normChain = `${scalePad},fps=${fpsVal},format=yuv420p`;
    const preChain = rotFilter ? `${rotFilter},${normChain}` : normChain;
    parts.push(`[${i}:v]${preChain}[v${i}pre]`);

    const clipTexts = usePerClipText ? (perClipTextLines[i] || []) : [];
    const clipEnabled = clipTexts.filter((l) => String(l.text || "").trim());
    if (clipEnabled.length > 0) {
      const drawFilters = clipEnabled.map((line) => {
        const textRel = writeDrawtextTextFile(workDir, textLineCounter++, line.text);
        const fontRel = mapFontToWorkDir(line.fontPath || resolvedFontPath, workDir, fontMap);
        return buildDrawtextOne(line, resolvedFontPath, textRel, fontRel);
      });
      parts.push(`[v${i}pre]${drawFilters.join(",")}[v${i}]`);
    } else {
      parts.push(`[v${i}pre]copy[v${i}]`);
    }

    const dur = Number.isFinite(inputInfos[i].duration) ? inputInfos[i].duration : 1;
    if (inputInfos[i].hasAudio) {
      parts.push(`[${i}:a]aformat=channel_layouts=stereo:sample_rates=${ar},aresample=async=1[a${i}]`);
    } else {
      parts.push(
        `anullsrc=channel_layout=stereo:sample_rate=${ar},atrim=0:${dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      );
    }
  }

  if (n === 1) {
    parts.push("[v0]copy[vcat]");
    parts.push("[a0]anull[acat]");
  } else {
    const concatIn = [];
    for (let i = 0; i < n; i++) concatIn.push(`[v${i}][a${i}]`);
    parts.push(`${concatIn.join("")}concat=n=${n}:v=1:a=1[vcat][acat]`);
  }

  if (!usePerClipText) {
    const enabledLines = (textLines || []).filter((l) => String(l.text || "").trim());
    if (enabledLines.length > 0) {
      const drawFilters = enabledLines.map((line) => {
        const textRel = writeDrawtextTextFile(workDir, textLineCounter++, line.text);
        const fontRel = mapFontToWorkDir(line.fontPath || resolvedFontPath, workDir, fontMap);
        return buildDrawtextOne(line, resolvedFontPath, textRel, fontRel);
      });
      parts.push(`[vcat]${drawFilters.join(",")}[vout]`);
    } else {
      parts.push("[vcat]copy[vout]");
    }
  } else {
    parts.push("[vcat]copy[vout]");
  }

  const filterScript = "filter.txt";
  fs.writeFileSync(path.join(workDir, filterScript), parts.join(";"), "utf8");
  return { workDir, filterScript };
}

function startFfmpegJob({
  jobId,
  inputs,
  inputInfos,
  textLines,
  perClipTextLines,
  resolvedFontPath,
  resolution,
  fps,
  videoBitrateMbps,
  preset,
  outputPath,
  metadata,
  aspectRatio,
  audioSampleRate,
  progressJob,
  mapVideo = "[vout]",
  mapAudio = "[acat]",
  filterBuild,
}) {
  const { workDir, filterScript } = filterBuild
    ? filterBuild()
    : buildFilterGraph({
        inputInfos,
        textLines,
        perClipTextLines,
        resolvedFontPath,
        resolution,
        fps,
        aspectRatio,
        jobId,
        audioSampleRate,
      });

  const absOutput = path.resolve(outputPath);
  const args = ["-y"];
  for (const f of inputs) args.push("-i", path.resolve(f));

  args.push("-filter_complex_script", filterScript, "-map", mapVideo, "-map", mapAudio);
  addVideoEncodeArgs(args, { resolution, videoBitrateMbps, preset, fps });
  addAudioEncodeArgs(args, audioSampleRate);

  addMetadataArgs(args, metadata.mode);
  args.push(absOutput);

  return new Promise((resolve, reject) => {
    activeFfmpegJobs += 1;
    const out = args[args.length - 1];
    const base = args.slice(0, -1);
    const proc = spawn("ffmpeg", base.concat(["-progress", "pipe:1", "-nostats", out]), {
      shell: false,
      cwd: workDir,
    });

    const job = progressJob || jobs.get(jobId);
    if (job && !progressJob) job.procPid = proc.pid;

    let lastErr = "";
    let stdoutBuf = "";
    let outTimeMs = 0;

    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      lastErr += chunk;
      if (lastErr.length > 16000) lastErr = lastErr.slice(-16000);

      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        const t = parseStderrTime(line);
        if (Number.isFinite(t) && job) updateJobProgress(job, t);
      }
    });

    proc.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        const parsed = parseProgressLine(line.trim());
        if (!parsed) continue;

        if (parsed.k === "out_time_ms") outTimeMs = Number(parsed.v);
        if (parsed.k === "speed") {
          const speed = Number(String(parsed.v).replace("x", ""));
          if (job && Number.isFinite(speed)) job.lastSpeed = speed;
        }
        if (parsed.k === "progress" && parsed.v === "end" && job) {
          job.progress = 100;
        }

        if (job && outTimeMs > 0) {
          updateJobProgress(job, outTimeMs / 1000000);
        }
      }
    });

    proc.on("close", (code) => {
      activeFfmpegJobs = Math.max(0, activeFfmpegJobs - 1);
      cleanupJobWorkDir(jobId);
      if (code === 0) {
        if (progressJob) {
          progressJob.progress = 100;
          progressJob.status = "done";
        } else if (jobs.has(jobId)) {
          const j = jobs.get(jobId);
          j.status = "done";
          j.progress = 100;
        }
        resolve({ ok: true });
      } else {
        const hint = translateFfmpegError(lastErr);
        if (progressJob) {
          progressJob.status = "error";
          progressJob.errorHint = hint;
          progressJob.errorDetail = (lastErr || `FFmpeg thoát mã ${code}`).slice(-3000);
        } else if (jobs.has(jobId)) {
          const j = jobs.get(jobId);
          j.status = "error";
          j.errorHint = hint;
          j.errorDetail = (lastErr || `FFmpeg thoát mã ${code}`).slice(-3000);
        }
        reject(new Error(hint));
      }
    });

    proc.on("error", (err) => {
      activeFfmpegJobs = Math.max(0, activeFfmpegJobs - 1);
      cleanupJobWorkDir(jobId);
      if (progressJob) {
        progressJob.status = "error";
        progressJob.errorHint = err.message || String(err);
        progressJob.errorDetail = progressJob.errorHint;
      } else if (jobs.has(jobId)) {
        const j = jobs.get(jobId);
        j.status = "error";
        j.errorHint = err.message || String(err);
        j.errorDetail = j.errorHint;
      }
      reject(err);
    });
  });
}

async function processBatchUpscale(batchJob, inputPaths, metadataMode) {
  const { resolution, fps, videoBitrateMbps, preset, aspectRatio, audioSampleRate } = batchJob.settings;
  const metadata = { mode: metadataMode };

  for (let i = 0; i < batchJob.items.length; i++) {
    const item = batchJob.items[i];
    batchJob.currentIndex = i;
    batchJob.currentName = item.originalName;
    item.status = "processing";

    const subJobId = `${batchJob.id}-f${i}`;
    const progressJob = {
      status: "processing",
      progress: 0,
      etaSeconds: NaN,
      lastOutTimeSec: 0,
      startedAt: Date.now(),
      totalDurationSec: item.durationSec,
      lastSpeed: 0,
    };

    const refreshBatchProgress = () => {
      const slice = (progressJob.progress || 0) / 100;
      batchJob.progress = ((i + slice) / batchJob.items.length) * 100;
    };

    const tick = setInterval(refreshBatchProgress, 400);

    try {
      await startFfmpegJob({
        jobId: subJobId,
        inputs: [item.inputPath],
        inputInfos: [{ duration: item.durationSec, hasAudio: item.hasAudio, rotation: item.rotation, displayWidth: item.displayWidth, displayHeight: item.displayHeight, width: item.width, height: item.height }],
        textLines: [],
        perClipTextLines: null,
        resolvedFontPath: "",
        resolution,
        fps,
        videoBitrateMbps,
        preset,
        outputPath: item.outputPath,
        metadata,
        aspectRatio,
        audioSampleRate,
        progressJob,
        mapVideo: "[vout]",
        mapAudio: "[aout]",
        filterBuild: () => buildUpscaleFilterGraph(
          {
            duration: item.durationSec,
            hasAudio: item.hasAudio,
            rotation: item.rotation,
            displayWidth: item.displayWidth,
            displayHeight: item.displayHeight,
            width: item.width,
            height: item.height,
          },
          resolution,
          fps,
          aspectRatio,
          subJobId,
          audioSampleRate
        ),
      });
      item.status = "done";
      batchJob.completedCount += 1;
    } catch (err) {
      item.status = "error";
      item.errorHint = err.message || String(err);
      batchJob.failedCount += 1;
    } finally {
      clearInterval(tick);
      try { fs.unlinkSync(item.inputPath); } catch {}
      refreshBatchProgress();
    }
  }

  batchJob.currentIndex = null;
  batchJob.currentName = null;
  batchJob.progress = 100;

  if (batchJob.completedCount === batchJob.items.length) {
    batchJob.status = "done";
  } else if (batchJob.completedCount > 0) {
    batchJob.status = "partial";
  } else {
    batchJob.status = "error";
    batchJob.errorHint = "Không nâng cấp được video nào.";
  }
  batchJob.doneAt = Date.now();
}

function cleanupUploads(paths) {
  for (const p of paths || []) {
    try { fs.unlinkSync(p); } catch {}
  }
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const age = now - (job.createdAt || job.startedAt || now);
    if (age > JOB_TTL_MS && job.status !== "processing") {
      jobs.delete(id);
    }
  }
}

function cleanupOldOutputs() {
  const now = Date.now();
  let files;
  try {
    files = fs.readdirSync(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    const fp = path.join(OUTPUT_DIR, f);
    try {
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > OUTPUT_MAX_AGE_MS) fs.unlinkSync(fp);
    } catch {}
  }
}

setInterval(() => {
  cleanupOldJobs();
  cleanupOldOutputs();
}, 30 * 60 * 1000);

function parseTextLines(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("Dữ liệu textLines không hợp lệ (JSON lỗi).");
  }
}

function parseOrder(raw, fileCount) {
  if (!raw) return [...Array(fileCount).keys()];
  try {
    const order = JSON.parse(raw);
    if (!Array.isArray(order)) return [...Array(fileCount).keys()];
    return order.map((i) => Number(i)).filter((i) => i >= 0 && i < fileCount);
  } catch {
    return [...Array(fileCount).keys()];
  }
}

function resolveOutputSettings(body, inputInfos) {
  const platform = String(body.platformPreset || "custom");
  const platformDefs = platform !== "custom" ? buildPlatformDefaults(platform) : null;
  const infos = Array.isArray(inputInfos) ? inputInfos : [];

  const resolution = validateResolution(body.resolution || platformDefs?.resolution || "1080p");
  const fpsMode = validateFpsMode(body.fpsMode || body.fps || platformDefs?.fpsMode || "auto");
  const preset = validatePreset(body.preset || platformDefs?.preset || "medium");
  const brMin = resolution === "4k" ? 25 : 8;
  const brMax = resolution === "4k" ? 50 : 15;
  const videoBitrateMbps = clamp(
    Number(body.videoBitrateMbps || platformDefs?.videoBitrateMbps || 12),
    brMin,
    brMax
  );

  const outputFps = resolveOutputFps(infos.map((i) => i.fps), fpsMode);
  const audioSampleRate = resolveAudioSampleRate(infos.map((i) => i.audioSampleRate));

  return { resolution, fpsMode, outputFps, videoBitrateMbps, preset, audioSampleRate };
}

app.post("/api/process", upload.array("videos", 20), async (req, res) => {
  const uploadedPaths = (req.files || []).map((f) => f.path);

  try {
    if (activeFfmpegJobs >= MAX_CONCURRENT_JOBS) {
      cleanupUploads(uploadedPaths);
      return res.status(429).json({
        error: "Server đang bận.",
        detail: `Tối đa ${MAX_CONCURRENT_JOBS} job render cùng lúc. Vui lòng thử lại sau.`,
      });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Chưa chọn video." });
    }

    const order = parseOrder(req.body.order, files.length);
    const orderedFiles = order.map((i) => files[i]).filter(Boolean);
    if (orderedFiles.length === 0) {
      cleanupUploads(uploadedPaths);
      return res.status(400).json({ error: "Thứ tự video không hợp lệ." });
    }

    const textMode = String(req.body.textMode || "manual");
    const textEnabled = parseTextEnabled(req.body.textEnabled);
    const inputPaths = orderedFiles.map((f) => f.path);
    const inputInfos = await Promise.all(inputPaths.map((p) => probeFileInfo(p)));
    const { resolution, outputFps, videoBitrateMbps, preset, audioSampleRate } = resolveOutputSettings(req.body, inputInfos);
    const aspectRatio = textMode === "outfit"
      ? validateAspectRatio(req.body.aspectRatio || "portrait")
      : validateAspectRatio(req.body.aspectRatio || "landscape");
    const metadataMode = req.body.metadataMode === "sensitive" ? "sensitive" : "all";

    const jobId = crypto.randomUUID();
    const accessToken = crypto.randomBytes(16).toString("hex");
    const outputName = `output-${Date.now()}-${jobId.slice(0, 8)}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    let enabledText = [];
    let perClipTextLines = null;
    let resolvedFontPath = DEFAULT_FONT_FILE || "";

    if (textEnabled && textMode === "outfit") {
      const explicitFont = String(req.body.fontFile || "").trim();
      let outfitUserFont = "";
      if (explicitFont) {
        try {
          outfitUserFont = validateFontFile(explicitFont);
        } catch (fontErr) {
          cleanupUploads(uploadedPaths);
          return res.status(400).json({ error: fontErr.message });
        }
      }
      resolvedFontPath = outfitUserFont || DEFAULT_FONT_BOLD || DEFAULT_FONT_FILE || "";

      const outfitSets = normalizeOutfitSets(parseOutfitSets(req.body.outfitSets), inputInfos.length);
      const outfitDisplaySec = clamp(Number(req.body.outfitDisplaySec) || OUTFIT_ANIM.displaySec, 1.5, 8);
      perClipTextLines = buildOutfitClipTexts(
        outfitSets,
        inputInfos,
        resolution,
        outfitUserFont,
        outfitDisplaySec,
        aspectRatio
      );
      if (!perClipTextLines.some((clip) => clip.length > 0)) {
        cleanupUploads(uploadedPaths);
        return res.status(400).json({ error: "Chưa cấu hình chữ cho bộ/set nào." });
      }
    } else if (textEnabled) {
      const textLines = parseTextLines(req.body.textLines);
      enabledText = textLines.filter((l) => String(l.text || "").trim());
      if (enabledText.length > 0) {
        try {
          resolvedFontPath = validateFontFile(req.body.fontFile || "");
        } catch (fontErr) {
          cleanupUploads(uploadedPaths);
          return res.status(400).json({ error: fontErr.message });
        }
      }
    }

    const totalDurationSec = inputInfos.reduce(
      (acc, info) => acc + (Number.isFinite(info.duration) ? info.duration : 0),
      0
    );

    jobs.set(jobId, {
      status: "processing",
      progress: 0,
      etaSeconds: NaN,
      lastOutTimeSec: 0,
      startedAt: Date.now(),
      createdAt: Date.now(),
      totalDurationSec,
      files: inputPaths,
      outputName,
      outputPath,
      accessToken,
    });

    try {
      startFfmpegJob({
        jobId,
        inputs: inputPaths,
        inputInfos,
        textLines: enabledText,
        perClipTextLines,
        resolvedFontPath,
        resolution,
        fps: outputFps,
        videoBitrateMbps,
        preset,
        outputPath,
        metadata: { mode: metadataMode },
        aspectRatio,
        audioSampleRate,
      })
        .then(() => {
          const j = jobs.get(jobId);
          if (j && j.status !== "error") j.doneAt = Date.now();
          cleanupUploads(inputPaths);
        })
        .catch(() => {
          cleanupUploads(inputPaths);
        });
    } catch (jobErr) {
      cleanupJobWorkDir(jobId);
      cleanupUploads(uploadedPaths);
      jobs.delete(jobId);
      return res.status(400).json({
        error: jobErr.message || "Không tạo được job FFmpeg.",
      });
    }

    return res.json({
      success: true,
      message: "Đang xử lý...",
      jobId,
      accessToken,
      downloadUrl: `/api/download/${jobId}?token=${accessToken}`,
    });
  } catch (e) {
    cleanupUploads(uploadedPaths);
    return res.status(500).json({
      error: "Lỗi khi tạo job.",
      detail: String(e.message || e).slice(0, 2000),
    });
  }
});

app.post("/api/batch-upscale", upload.array("videos", 20), async (req, res) => {
  const uploadedPaths = (req.files || []).map((f) => f.path);

  try {
    if (activeFfmpegJobs >= MAX_CONCURRENT_JOBS) {
      cleanupUploads(uploadedPaths);
      return res.status(429).json({
        error: "Server đang bận.",
        detail: `Tối đa ${MAX_CONCURRENT_JOBS} job render cùng lúc. Vui lòng thử lại sau.`,
      });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "Chưa chọn video." });
    }

    const inputInfos = await Promise.all(files.map((f) => probeFileInfo(f.path)));
    const { resolution, outputFps, videoBitrateMbps, preset, audioSampleRate } = resolveOutputSettings(req.body, inputInfos);
    const aspectRatio = validateAspectRatio(req.body.aspectRatio || "portrait");
    const metadataMode = req.body.metadataMode === "sensitive" ? "sensitive" : "all";

    const jobId = crypto.randomUUID();
    const accessToken = crypto.randomBytes(16).toString("hex");

    const items = files.map((f, i) => {
      const info = inputInfos[i];
      const outputName = buildUpscaleOutputName(f.originalname, resolution, i);
      return {
        originalName: f.originalname,
        inputPath: f.path,
        outputName,
        outputPath: path.join(OUTPUT_DIR, outputName),
        status: "pending",
        durationSec: Number.isFinite(info.duration) ? info.duration : 0,
        hasAudio: info.hasAudio,
        rotation: info.rotation,
        displayWidth: info.displayWidth,
        displayHeight: info.displayHeight,
        width: info.width,
        height: info.height,
        errorHint: null,
      };
    });

    const batchJob = {
      id: jobId,
      type: "batch-upscale",
      status: "processing",
      progress: 0,
      completedCount: 0,
      failedCount: 0,
      currentIndex: 0,
      currentName: items[0]?.originalName || null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      accessToken,
      settings: { resolution, fps: outputFps, videoBitrateMbps, preset, aspectRatio, audioSampleRate },
      items,
    };

    jobs.set(jobId, batchJob);

    processBatchUpscale(batchJob, uploadedPaths, metadataMode).catch(() => {});

    return res.json({
      success: true,
      message: "Đang nâng cấp hàng loạt...",
      jobId,
      accessToken,
      totalCount: items.length,
    });
  } catch (e) {
    cleanupUploads(uploadedPaths);
    return res.status(500).json({
      error: "Lỗi khi tạo job nâng cấp hàng loạt.",
      detail: String(e.message || e).slice(0, 2000),
    });
  }
});

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Không tìm thấy job." });

  if (job.type === "batch-upscale") {
    return res.json({
      type: job.type,
      status: job.status,
      progress: job.progress ?? 0,
      completedCount: job.completedCount ?? 0,
      failedCount: job.failedCount ?? 0,
      totalCount: job.items?.length ?? 0,
      currentIndex: job.currentIndex,
      currentName: job.currentName,
      items: (job.items || []).map((it, i) => ({
        name: it.originalName,
        status: it.status,
        outputUrl: it.status === "done"
          ? `/api/download/${req.params.jobId}/${i}?token=${job.accessToken}`
          : null,
        errorHint: it.errorHint || null,
      })),
      errorHint: job.status === "error" ? job.errorHint || null : null,
    });
  }

  const downloadUrl =
    job.status === "done"
      ? `/api/download/${req.params.jobId}?token=${job.accessToken}`
      : null;

  res.json({
    status: job.status,
    progress: job.progress ?? 0,
    etaSeconds: job.etaSeconds,
    etaText: Number.isFinite(job.etaSeconds) ? formatHHMMSS(job.etaSeconds) : null,
    lastOutTimeSec: job.lastOutTimeSec ?? 0,
    outputUrl: downloadUrl,
    errorHint: job.status === "error" ? job.errorHint || null : null,
    errorDetail: job.status === "error" ? job.errorDetail || null : null,
  });
});

app.get("/api/download/:jobId/:fileIndex", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.type !== "batch-upscale") {
    return res.status(404).json({ error: "Job không tồn tại hoặc không phải batch." });
  }
  if (req.query.token !== job.accessToken) {
    return res.status(403).json({ error: "Token tải file không hợp lệ." });
  }
  const idx = Number(req.params.fileIndex);
  const item = job.items?.[idx];
  if (!item || item.status !== "done") {
    return res.status(404).json({ error: "File chưa sẵn sàng hoặc không tồn tại." });
  }
  if (!fs.existsSync(item.outputPath)) {
    return res.status(404).json({ error: "File đầu ra đã bị xóa." });
  }
  res.download(item.outputPath, item.outputName);
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.type === "batch-upscale") {
    return res.status(404).json({ error: "File chưa sẵn sàng hoặc không tồn tại." });
  }
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "File chưa sẵn sàng hoặc không tồn tại." });
  }
  if (req.query.token !== job.accessToken) {
    return res.status(403).json({ error: "Token tải file không hợp lệ." });
  }
  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: "File đầu ra đã bị xóa." });
  }
  res.download(job.outputPath, job.outputName);
});

app.get("/api/health", (_req, res) => {
  const proc = spawn("ffmpeg", ["-version"], { shell: false });
  proc.on("close", (code) => {
    res.json({
      ffmpeg: code === 0,
      activeJobs: activeFfmpegJobs,
      defaultFont: Boolean(DEFAULT_FONT_FILE),
      outfitFonts: {
        title: path.basename(DEFAULT_FONT_TITLE || ""),
        subtitle: path.basename(DEFAULT_FONT_SUBTITLE || ""),
        badge: path.basename(DEFAULT_FONT_BADGE || ""),
      },
    });
  });
  proc.on("error", () => res.json({ ffmpeg: false, activeJobs: activeFfmpegJobs }));
});

const server = app.listen(PORT, () => {
  console.log(`Server chạy tại: http://localhost:${PORT}`);
  if (!DEFAULT_FONT_FILE) {
    console.warn("Cảnh báo: không tìm thấy font mặc định. Hãy nhập đường dẫn font trên giao diện.");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Cổng ${PORT} đang được sử dụng. Hãy dừng process cũ hoặc đặt PORT khác.`);
  } else {
    console.error("Lỗi server:", err);
  }
  process.exit(1);
});
