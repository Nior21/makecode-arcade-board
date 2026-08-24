#!/usr/bin/env node
/**
 * Фоновый супервизор прошивки: следит за версией UF2 и ждёт консоль только если
 * текущая сборка ещё не прошита. Если уже прошита — отдыхает и периодически проверяет.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { waitForFlash, probeMounts, writeStatus } = require('./flash-wait.js');

const ROOT = path.join(__dirname, '..');
const GAMES_DIR = path.join(ROOT, 'games');
const REGISTRY_FILE = path.join(ROOT, '.flash-registry.json');

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function registryKey(slug, hw) {
  return `${slug}:${hw}`;
}

function resolveUf2Path(slug, hw) {
  return path.join(GAMES_DIR, slug, 'built', hw, 'binary.uf2');
}

function uf2Fingerprint(uf2Path) {
  const st = fs.statSync(uf2Path);
  return { size: st.size, mtime_ms: st.mtimeMs, id: `${st.size}:${Math.floor(st.mtimeMs)}` };
}

function getFlashedRecord(slug, hw) {
  return loadRegistry()[registryKey(slug, hw)] || null;
}

function markFlashed(slug, hw, fingerprint, result) {
  const reg = loadRegistry();
  reg[registryKey(slug, hw)] = {
    fingerprint: fingerprint.id,
    size: fingerprint.size,
    mtime_ms: fingerprint.mtime_ms,
    flashed_at: new Date().toISOString(),
    mount: result.mount || null,
    copy_ms: result.copy_ms || null,
  };
  saveRegistry(reg);
}

function needsFlash(slug, hw) {
  const uf2Path = resolveUf2Path(slug, hw);
  if (!fs.existsSync(uf2Path)) return { needed: false, reason: 'no_uf2', uf2_path: uf2Path };
  const fp = uf2Fingerprint(uf2Path);
  const rec = getFlashedRecord(slug, hw);
  if (!rec || rec.fingerprint !== fp.id) {
    return { needed: true, reason: rec ? 'new_build' : 'never_flashed', fingerprint: fp, uf2_path: uf2Path };
  }
  return { needed: false, reason: 'already_flashed', fingerprint: fp, flashed_at: rec.flashed_at, uf2_path: uf2Path };
}

function listGameSlugs() {
  try {
    return fs.readdirSync(GAMES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_template')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Самая свежая сборка, которую ещё не прошивали. */
function findPendingFlash(hw) {
  const pending = [];
  for (const slug of listGameSlugs()) {
    const check = needsFlash(slug, hw);
    if (check.needed) pending.push({ slug, hw, ...check });
  }
  if (!pending.length) return null;
  pending.sort((a, b) => (b.fingerprint?.mtime_ms || 0) - (a.fingerprint?.mtime_ms || 0));
  return pending[0];
}

function listAllPending(hw) {
  return listGameSlugs()
    .map((slug) => {
      const check = needsFlash(slug, hw);
      return { slug, hw, ...check };
    })
    .filter((x) => x.needed);
}

function createSupervisor(opts = {}) {
  const fixedSlug = opts.slug || null;
  const hw = opts.hw || process.env.MC_HW || 'samd51';
  const checkMs = Number(opts.checkMs || process.env.FLASH_CHECK_MS || 5000);
  const flashTimeoutSec = Number(opts.flashTimeoutSec || process.env.FLASH_TIMEOUT_SEC || 180);
  let running = false;
  let loopPromise = null;
  let flashActive = false;
  let activeSlug = fixedSlug;

  const state = {
    enabled: false,
    slug: activeSlug,
    hw,
    auto: !fixedSlug,
    mode: 'stopped',
    reason: null,
    fingerprint: null,
    flashed_at: null,
    last_check_at: null,
    last_flash_result: null,
    pending: [],
    cycles: 0,
  };

  function resolveTarget() {
    if (fixedSlug) {
      const check = needsFlash(fixedSlug, hw);
      return check.needed ? { slug: fixedSlug, hw, ...check } : null;
    }
    return findPendingFlash(hw);
  }

  function updateState(patch) {
    Object.assign(state, patch, { last_check_at: new Date().toISOString() });
    writeStatus({
      supervisor: state,
      waiting: flashActive,
      game: state.slug,
      hw,
    });
  }

  async function tick() {
    state.cycles += 1;
    state.pending = listAllPending(hw).map((p) => ({
      slug: p.slug,
      reason: p.reason,
      fingerprint: p.fingerprint?.id || null,
    }));

    const target = resolveTarget();
    if (!target) {
      activeSlug = fixedSlug || state.slug;
      updateState({
        slug: activeSlug,
        mode: 'idle',
        reason: fixedSlug ? needsFlash(fixedSlug, hw).reason : 'all_flashed',
        fingerprint: fixedSlug ? needsFlash(fixedSlug, hw).fingerprint?.id || null : null,
        flashed_at: fixedSlug ? getFlashedRecord(fixedSlug, hw)?.flashed_at || null : null,
      });
      return;
    }

    activeSlug = target.slug;
    if (flashActive) return;

    flashActive = true;
    updateState({
      slug: target.slug,
      mode: 'waiting',
      reason: target.reason,
      fingerprint: target.fingerprint.id,
      flashed_at: null,
    });

    try {
      const result = await waitForFlash(target.slug, hw, flashTimeoutSec);
      state.last_flash_result = result;
      if (result.ok) {
        markFlashed(target.slug, hw, target.fingerprint, result);
        updateState({
          slug: target.slug,
          mode: 'idle',
          reason: 'flashed_ok',
          fingerprint: target.fingerprint.id,
          flashed_at: new Date().toISOString(),
        });
      } else {
        updateState({
          slug: target.slug,
          mode: 'idle',
          reason: result.error === 'timeout' ? 'flash_timeout' : 'flash_error',
          fingerprint: target.fingerprint.id,
        });
      }
    } catch (err) {
      state.last_flash_result = { ok: false, error: err.message };
      updateState({ slug: target.slug, mode: 'idle', reason: 'flash_error', fingerprint: target.fingerprint.id });
    } finally {
      flashActive = false;
    }
  }

  async function loop() {
    while (running) {
      await tick();
      if (!running) break;
      await new Promise((r) => setTimeout(r, checkMs));
    }
  }

  return {
    getState() {
      const slug = state.slug || activeSlug;
      return {
        ...state,
        flash_active: flashActive,
        registry: slug ? getFlashedRecord(slug, hw) : null,
        probe: probeMounts(),
      };
    },
    start() {
      if (running) return state;
      running = true;
      state.enabled = true;
      state.mode = 'starting';
      loopPromise = loop().catch((err) => {
        state.mode = 'error';
        state.reason = err.message;
      });
      return state;
    },
    stop() {
      running = false;
      state.enabled = false;
      state.mode = 'stopped';
      state.reason = 'stopped';
      return state;
    },
    async forceRecheck() {
      await tick();
      return this.getState();
    },
    needsFlash() {
      const slug = state.slug || activeSlug || fixedSlug;
      return slug ? needsFlash(slug, hw) : { needed: false, reason: 'no_target' };
    },
    findPendingFlash() {
      return findPendingFlash(hw);
    },
    listAllPending() {
      return listAllPending(hw);
    },
  };
}

module.exports = {
  createSupervisor,
  needsFlash,
  findPendingFlash,
  listAllPending,
  listGameSlugs,
  markFlashed,
  getFlashedRecord,
  uf2Fingerprint,
  loadRegistry,
  REGISTRY_FILE,
};
