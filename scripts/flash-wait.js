#!/usr/bin/env node
/**
 * Ждёт появления UF2-консоли (USB OTG) и мгновенно копирует .uf2.
 * Оптимизировано под короткое окно монтирования на Android (~2–5 с).
 *
 * Использование:
 *   node scripts/flash-wait.js [game-slug] [hw] [timeout_sec]
 *   node scripts/flash-wait.js my-test stm32f401 120
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games');
const DEFAULT_HW = process.env.MC_HW || 'samd51';
const POLL_MS = Number(process.env.FLASH_POLL_MS || 50);
const STATUS_FILE = path.join(ROOT, '.flash-status.json');

function readMounts() {
  try {
    return fs.readFileSync('/proc/mounts', 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** Все vfat-тома под /mnt/media_rw/ (типичный путь OTG на Android). */
function listMediaRwMounts(lines) {
  const out = [];
  for (const line of lines) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const mountPath = parts[1];
    const fsType = parts[2];
    if (fsType === 'vfat' && mountPath.startsWith('/mnt/media_rw/')) {
      out.push(mountPath);
    }
  }
  return out;
}

function readUf2Info(mountPath) {
  const infoPath = path.join(mountPath, 'INFO_UF2.TXT');
  try {
    const text = fs.readFileSync(infoPath, 'utf8');
    const model = (text.match(/^Model:\s*(.+)$/m) || [])[1]?.trim() || null;
    const boardId = (text.match(/^Board-ID:\s*(.+)$/m) || [])[1]?.trim() || null;
    return { model, board_id: boardId, info: text.split('\n').slice(0, 4).join(' ').trim() };
  } catch {
    return null;
  }
}

function isUf2Bootloader(mountPath) {
  try {
    fs.accessSync(path.join(mountPath, 'INFO_UF2.TXT'), fs.constants.R_OK);
    return true;
  } catch {
    try {
      fs.accessSync(path.join(mountPath, 'CURRENT.UF2'), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function writeStatus(data) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2));
  } catch (_) {}
}

function resolveUf2(slug, hw) {
  const uf2Path = path.join(GAMES_DIR, slug, 'built', hw, 'binary.uf2');
  if (!fs.existsSync(uf2Path)) {
    throw new Error(`UF2 не найден: ${uf2Path}\nСначала: bash scripts/build.sh games/${slug} ${hw}`);
  }
  return uf2Path;
}

function flashCopy(mountPath, destName, data) {
  const dest = path.join(mountPath, destName);
  const t0 = Date.now();
  const fd = fs.openSync(dest, 'w');
  try {
    fs.writeSync(fd, data, 0, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { dest, ms: Date.now() - t0 };
}

/** Снимок подключённых UF2-устройств (для диагностики). */
function probeMounts() {
  const mounts = listMediaRwMounts(readMounts());
  const devices = [];
  for (const mount of mounts) {
    const entry = { mount, accessible: false, uf2: false };
    try {
      fs.accessSync(mount, fs.constants.R_OK | fs.constants.W_OK);
      entry.accessible = true;
    } catch (_) {}
    if (isUf2Bootloader(mount)) {
      entry.uf2 = true;
      Object.assign(entry, readUf2Info(mount) || {});
    }
    devices.push(entry);
  }
  return { mounts, devices, polled_at: new Date().toISOString() };
}

async function waitForFlash(slug, hw, timeoutSec) {
  const uf2Path = resolveUf2(slug, hw);
  const uf2Data = fs.readFileSync(uf2Path);
  const destName = `${slug}.uf2`;
  const flashed = new Set();

  const state = {
    waiting: true,
    game: slug,
    hw,
    uf2_path: uf2Path,
    uf2_size: uf2Data.length,
    timeout_sec: timeoutSec,
    poll_ms: POLL_MS,
    started_at: new Date().toISOString(),
    last_probe: null,
    result: null,
  };
  writeStatus(state);

  console.log(`[flash-wait] UF2 загружен в память: ${uf2Data.length} байт`);
  console.log(`[flash-wait] Жду UF2-консоль (OTG). Подключите и reset → bootloader. Таймаут ${timeoutSec} с`);
  console.log(`[flash-wait] Ищу INFO_UF2.TXT на /mnt/media_rw/* (опрос ${POLL_MS} мс)`);

  const initial = probeMounts();
  if (initial.devices.some((d) => d.uf2)) {
    console.log(`[flash-wait] Уже подключено: ${JSON.stringify(initial.devices.filter((d) => d.uf2))}`);
  }

  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const probe = probeMounts();
    state.last_probe = probe;
    writeStatus(state);

    const mounted = new Set(probe.mounts);
    for (const m of flashed) {
      if (!mounted.has(m)) flashed.delete(m);
    }

    for (const dev of probe.devices) {
      if (!dev.uf2 || flashed.has(dev.mount)) continue;

      const detectMs = Date.now();
      const label = dev.model || dev.mount;
      console.log(`[flash-wait] UF2-консоль: ${dev.mount} (${label}) — копирую немедленно`);

      try {
        const { dest, ms } = flashCopy(dev.mount, destName, uf2Data);
        flashed.add(dev.mount);
        const totalMs = Date.now() - detectMs;
        const result = {
          ok: true,
          mount: dev.mount,
          device: dev,
          dest,
          copy_ms: ms,
          total_ms: totalMs,
          message: `Скопировано на ${label} за ${ms} мс`,
        };
        state.waiting = false;
        state.result = result;
        writeStatus(state);
        console.log(`[flash-wait] OK: ${dest} (${result.message})`);
        return result;
      } catch (err) {
        const result = {
          ok: false,
          mount: dev.mount,
          device: dev,
          error: err.message,
          hint: 'Том исчез слишком быстро — OTG-хаб с питанием, экран не гасить',
        };
        state.waiting = false;
        state.result = result;
        writeStatus(state);
        console.error(`[flash-wait] Ошибка копирования: ${err.message}`);
        return result;
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const last = probeMounts();
  const result = {
    ok: false,
    error: 'timeout',
    message: `UF2-консоль не появилась за ${timeoutSec} с`,
    last_probe: last,
  };
  state.waiting = false;
  state.result = result;
  writeStatus(state);
  console.error(`[flash-wait] ${result.message}`);
  if (last.devices.length) {
    console.error(`[flash-wait] Последний опрос: ${JSON.stringify(last.devices)}`);
  } else {
    console.error('[flash-wait] /mnt/media_rw/* — пусто (консоль не монтировалась или уже отключилась)');
  }
  process.exitCode = 1;
  return result;
}

// CLI
if (require.main === module) {
  const slug = process.argv[2] || 'my-test';
  const hw = process.argv[3] || DEFAULT_HW;
  const timeout = Number(process.argv[4] || 120);

  waitForFlash(slug, hw, timeout)
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => {
      writeStatus({ waiting: false, result: { ok: false, error: err.message } });
      console.error(`[flash-wait] ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  waitForFlash,
  readMounts,
  listMediaRwMounts,
  probeMounts,
  writeStatus,
  STATUS_FILE,
};
