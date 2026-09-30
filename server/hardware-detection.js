'use strict';
/*
 * hardware-detection.js
 * Detects whether this machine can realistically run PS3 emulation (RPCS3)
 * and hardware-accelerated WebRTC streaming.
 *
 * Honest by design: it reports what it finds and never claims suitability
 * the hardware does not support. RPCS3 needs a Vulkan-capable GPU for
 * playable performance — a CPU-only cloud box will be flagged.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function commandExists(cmd) {
  return tryExec(`command -v ${cmd}`) !== null;
}

function detectCPU() {
  const cpus = os.cpus();
  return {
    model: cpus[0] ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    arch: os.arch(),
  };
}

function detectRAM() {
  const bytes = os.totalmem();
  return { bytes, gb: +(bytes / 1024 ** 3).toFixed(1) };
}

function detectGPU() {
  // NVIDIA via nvidia-smi (most reliable, also gives VRAM + encoder info)
  const smi = tryExec(
    'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader'
  );
  if (smi) {
    const [name, mem, driver] = smi.split(',').map((s) => s.trim());
    return {
      vendor: 'NVIDIA',
      name,
      vram: mem || 'unknown',
      driver: driver || 'unknown',
      via: 'nvidia-smi',
    };
  }
  // Fallback: lspci
  const lspci = tryExec("lspci 2>/dev/null | grep -iE 'vga|3d|display'");
  if (lspci) {
    const line = lspci.split('\n')[0];
    const vendor = /nvidia/i.test(line)
      ? 'NVIDIA'
      : /amd|radeon/i.test(line)
        ? 'AMD'
        : /intel/i.test(line)
          ? 'Intel'
          : 'unknown';
    return { vendor, name: line.trim(), vram: 'unknown', driver: 'unknown', via: 'lspci' };
  }
  return { vendor: 'unknown', name: 'no GPU detected', vram: 'unknown', via: 'none' };
}

function detectEncoders(gpu) {
  // Hardware encoders suitable for low-latency game streaming.
  const encoders = [];
  if (gpu.via === 'nvidia-smi') encoders.push('NVENC (nvh264enc)');
  // VA-API (Intel Quick Sync / AMD VCN) — render node present is a good hint
  try {
    const dri = fs.readdirSync('/dev/dri');
    if (dri.some((f) => f.startsWith('renderD'))) encoders.push('VA-API (vaapih264enc)');
  } catch { /* no /dev/dri */ }
  encoders.push('CPU x264 (x264enc, high latency / high CPU cost)');
  return encoders;
}

function detectVulkan() {
  if (commandExists('vulkaninfo')) {
    const out = tryExec('vulkaninfo --summary 2>/dev/null | grep -iE "deviceName|driverID" | head -5');
    return { available: true, via: 'vulkaninfo', detail: out || 'present' };
  }
  const libPaths = [
    '/usr/lib/x86_64-linux-gnu/libvulkan.so.1',
    '/usr/lib/libvulkan.so.1',
  ];
  if (libPaths.some((p) => fs.existsSync(p))) {
    return { available: true, via: 'libvulkan.so.1', detail: 'library present, vulkaninfo not installed' };
  }
  return { available: false, via: 'none', detail: 'no Vulkan loader found' };
}

function detectOpenGL() {
  if (commandExists('glxinfo')) {
    const out = tryExec('glxinfo -B 2>/dev/null | grep -iE "OpenGL version|renderer" | head -4');
    return { available: true, via: 'glxinfo', detail: out || 'present' };
  }
  return { available: false, via: 'none', detail: 'glxinfo not installed' };
}

function detectDisk(dir) {
  const target = dir && fs.existsSync(dir) ? dir : '/';
  const out = tryExec(`df -BG --output=avail "${target}" | tail -1`);
  const gb = out ? parseInt(out.replace('G', '').trim(), 10) : null;
  return { path: target, availableGB: Number.isNaN(gb) ? null : gb };
}

function vramGB(gpu) {
  if (!gpu.vram || gpu.vram === 'unknown') return null;
  const m = gpu.vram.match(/([\d.]+)\s*MiB/i);
  return m ? +(parseInt(m[1], 10) / 1024).toFixed(1) : null;
}

/**
 * Returns { suitable: true|false, reasons: [...] }.
 * Rules are conservative: RPCS3 + God of War III class titles need a real GPU.
 */
function verdict(report) {
  const reasons = [];
  let suitable = true;

  if (!report.vulkan.available) {
    suitable = false;
    reasons.push('No Vulkan support detected — RPCS3 requires Vulkan for playable performance.');
  }
  const vram = vramGB(report.gpu);
  if (report.gpu.vendor === 'unknown' || report.gpu.name === 'no GPU detected') {
    suitable = false;
    reasons.push('No GPU detected — CPU-only rendering cannot run PS3 emulation at playable speed.');
  } else if (vram !== null && vram < 4) {
    suitable = false;
    reasons.push(`Only ${vram} GB VRAM detected — 4 GB or more is recommended.`);
  }
  const hwEnc = report.encoders.some((e) => /NVENC|VA-API/.test(e));
  if (!hwEnc) {
    suitable = false;
    reasons.push('No hardware video encoder (NVENC/VA-API) — CPU encoding adds latency and load.');
  }
  if (report.cpu.cores < 4) {
    suitable = false;
    reasons.push(`Only ${report.cpu.cores} CPU cores — 4+ cores recommended.`);
  }
  if (report.ram.gb < 8) {
    suitable = false;
    reasons.push(`Only ${report.ram.gb} GB RAM — 8 GB or more recommended.`);
  }
  if (report.disk.availableGB !== null && report.disk.availableGB < 20) {
    suitable = false;
    reasons.push(`Only ${report.disk.availableGB} GB disk free — 20 GB+ recommended for emulator + games.`);
  }
  if (report.cpu.arch !== 'x64') {
    suitable = false;
    reasons.push(`CPU architecture is ${report.cpu.arch} — RPCS3 requires x86-64.`);
  }

  if (suitable) {
    reasons.push('Hardware looks capable of PS3 emulation with hardware-accelerated streaming.');
  }
  return {
    suitable,
    summary: suitable
      ? 'Your server appears suitable for PS3 emulation.'
      : 'Your server may be insufficient for PS3 emulation.',
    reasons,
  };
}

function detect(gameDir) {
  const cpu = detectCPU();
  const ram = detectRAM();
  const gpu = detectGPU();
  const report = {
    cpu,
    ram,
    gpu,
    encoders: detectEncoders(gpu),
    vulkan: detectVulkan(),
    opengl: detectOpenGL(),
    disk: detectDisk(gameDir),
    checkedAt: new Date().toISOString(),
  };
  report.verdict = verdict(report);
  return report;
}

// CLI: node server/hardware-detection.js --cli
if (require.main === module && process.argv.includes('--cli')) {
  const r = detect(process.env.GAME_DIRECTORY);
  const line = (s) => console.log(s);
  line('── Hardware detection ──────────────────────────────');
  line(`CPU:      ${r.cpu.model} (${r.cpu.cores} cores, ${r.cpu.arch})`);
  line(`RAM:      ${r.ram.gb} GB`);
  line(`GPU:      ${r.gpu.name} [${r.gpu.vendor}]`);
  line(`VRAM:     ${r.gpu.vram}`);
  line(`Encoders: ${r.encoders.join(', ')}`);
  line(`Vulkan:   ${r.vulkan.available ? 'yes' : 'NO'} (${r.vulkan.detail})`);
  line(`OpenGL:   ${r.opengl.available ? 'yes' : 'NO'} (${r.opengl.detail})`);
  line(`Disk:     ${r.disk.availableGB} GB free at ${r.disk.path}`);
  line('────────────────────────────────────────────────────');
  line(r.verdict.summary);
  r.verdict.reasons.forEach((x) => line(`  • ${x}`));
  process.exit(r.verdict.suitable ? 0 : 2);
}

module.exports = { detect };
