const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { promisify } = require("util");

const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");

[UPLOAD_DIR, OUTPUT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(OUTPUT_DIR));

function escapeDrawtext(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
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

function buildScaleFilter(resolution) {
  if (resolution === "1080p") {
    return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
  }
  if (resolution === "4k") {
    return "scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2";
  }
  return null;
}

function buildDrawtextFilter(text, position, fontsize, opacity) {
  const pos = getPosition(position);
  const safe = escapeDrawtext(text);
  return (
    `drawtext=text='${safe}':` +
    `fontcolor=white@${opacity}:` +
    `fontsize=${fontsize}:` +
    `x=${pos.x}:y=${pos.y}:` +
    `borderw=2:bordercolor=black@0.6`
  );
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { shell: false });
    let stderr = "";

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(stderr || `FFmpeg thoát với mã ${code}`));
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("Không tìm thấy FFmpeg. Hãy cài FFmpeg và thêm vào PATH."));
      } else {
        reject(err);
      }
    });
  });
}

async function cleanupDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    await unlink(path.join(dir, f));
  }
  await rmdir(dir);
}

app.post(
  "/api/process",
  upload.array("videos", 20),
  async (req, res) => {
    const sessionDir = path.join(UPLOAD_DIR, `session-${Date.now()}`);
    const files = req.files || [];

    if (files.length === 0) {
      return res.status(400).json({ error: "Vui lòng chọn ít nhất 1 video." });
    }

    const {
      text = "",
      resolution = "1080p",
      fps = "60",
      position = "bottom",
      fontsize = "48",
      opacity = "0.8",
      crf = "20",
      preset = "slow",
      removeMetadata = "1",
    } = req.body;

    if (!text.trim()) {
      for (const f of files) await unlink(f.path).catch(() => {});
      return res.status(400).json({ error: "Vui lòng nhập nội dung chữ." });
    }

    await mkdir(sessionDir, { recursive: true });

    const orderedPaths = [];
    const orderRaw = req.body.order;
    const order = orderRaw ? JSON.parse(orderRaw) : files.map((_, i) => i);

    for (const idx of order) {
      const file = files[idx];
      if (file) orderedPaths.push(file.path);
    }

    const listFile = path.join(sessionDir, "inputs.txt");
    const listContent = orderedPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
    fs.writeFileSync(listFile, listContent, "utf8");

    const outputName = `output-${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    const scale = buildScaleFilter(resolution);
    const drawtext = buildDrawtextFilter(text, position, fontsize, opacity);
    const vf = scale ? `${scale},${drawtext}` : drawtext;

    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-vf", vf,
      "-r", String(fps),
      "-c:v", "libx265",
      "-preset", preset,
      "-crf", String(crf),
      "-pix_fmt", "yuv420p",
      "-tag:v", "hvc1",
      "-c:a", "aac",
      "-b:a", "192k",
      outputPath,
    ];

    const shouldRemoveMetadata = String(removeMetadata) !== "0";
    if (shouldRemoveMetadata) {
      // Xóa metadata toàn bộ (metadata toàn cục + metadata luồng) khi xuất file.
      // Đặt trước outputPath để FFmpeg luôn nhận đúng tham số.
      args.splice(args.length - 1, 0, "-map_metadata", "-1");
    }

    try {
      await runFfmpeg(args);

      for (const f of files) await unlink(f.path).catch(() => {});
      await unlink(listFile).catch(() => {});
      await cleanupDir(sessionDir).catch(() => {});

      res.json({
        success: true,
        message: "Xử lý video thành công!",
        downloadUrl: `/outputs/${outputName}`,
        filename: outputName,
      });
    } catch (err) {
      for (const f of files) await unlink(f.path).catch(() => {});
      await cleanupDir(sessionDir).catch(() => {});

      res.status(500).json({
        error: "Lỗi khi xử lý video.",
        detail: err.message.slice(-2000),
      });
    }
  }
);

app.get("/api/health", (_req, res) => {
  const proc = spawn("ffmpeg", ["-version"], { shell: false });
  proc.on("close", (code) => {
    res.json({ ffmpeg: code === 0 });
  });
  proc.on("error", () => {
    res.json({ ffmpeg: false });
  });
});

app.listen(PORT, () => {
  console.log(`Server chạy tại: http://localhost:${PORT}`);
});
