// ==============================================================
// GeoFS Fighter Jet Realistic Fuel System
// Version: 4.1.0
// Repository: https://github.com/YOUR_USERNAME/YOUR_REPO
// ==============================================================
// Features:
//   - Realistic fuel burn (throttle, afterburner, engine state)
//   - Expanded fighter jet database (F-22, F-35, F-14, F-15, J-20, …)
//   - Draggable HUD, fuel bar, burn rate, endurance
//   - Ground-only refuelling via HUD button
//   - Dynamic RTB bingo: calculates return fuel from current position
//   - Auto nearest-base selection (or manual pick in settings)
//   - Multiple saved airbases
//   - H key toggles HUD
// ==============================================================

(function () {
    'use strict';

    // ── Version ──────────────────────────────────────────────
    const VERSION = '4.1.0';

    // ── Aircraft fuel database ────────────────────────────────
    // capacity: internal fuel in kg  |  engines: number of engines
    const FIGHTER_FUEL_DB = {
        'f-16':        { capacity:  3175, engines: 1, name: 'F-16 Fighting Falcon'  },
        'f/a-18f':     { capacity:  6532, engines: 2, name: 'F/A-18F Super Hornet'  },
        'f-14':        { capacity:  7348, engines: 2, name: 'F-14B Tomcat'           },
        'f-15':        { capacity:  6103, engines: 2, name: 'F-15C Eagle'            },
        'f-22':        { capacity:  8200, engines: 2, name: 'F-22 Raptor'            },
        'f-35':        { capacity:  6125, engines: 1, name: 'F-35B Lightning II'     },
        'yf-23':       { capacity:  8600, engines: 2, name: 'YF-23'                  },
        'su-35':       { capacity: 11500, engines: 2, name: 'Su-35'                  },
        'rafale':      { capacity:  4700, engines: 2, name: 'Dassault Rafale'        },
        'mirage f1':   { capacity:  4300, engines: 1, name: 'Mirage F1'              },
        'mirage 2000': { capacity:  3978, engines: 1, name: 'Mirage 2000-5'          },
        'j-20':        { capacity: 11340, engines: 2, name: 'Chengdu J-20'           },
        'a-10':        { capacity:  4853, engines: 2, name: 'A-10C Thunderbolt II'   },
        'alpha':       { capacity:  1900, engines: 2, name: 'Alpha Jet'              },
        't-38':        { capacity:  1540, engines: 2, name: 'T-38 Talon'             }
    };

    // ── State ─────────────────────────────────────────────────
    let fuelState = {
        fuel: 0,
        maxFuel: 0,
        initialized: false,
        lastAircraft: null
    };

    let hudVisible   = true;
    let isDragging   = false;
    let dragOffsetX  = 0, dragOffsetY = 0;
    let hudLeft      = null, hudTop   = null;

    // ── Settings (runtime only — no localStorage) ─────────────
    const settings = {
        dynamicBingoEnabled: false,
        autoNearestBase:     true,      // auto-select nearest base when true
        reserveMinutes:      10,
        cruiseSpeedKmh:      900,
        bases:               [],
        selectedBaseIndex:   0
    };

    // ──────────────────────────────────────────────────────────
    // AIRCRAFT DETECTION
    // ──────────────────────────────────────────────────────────

    function detectAircraftType() {
        const name = (window.geofs.aircraft.instance.aircraftRecord.name || '').toLowerCase();
        for (const key of Object.keys(FIGHTER_FUEL_DB)) {
            if (name.includes(key)) return key;
        }
        const eng = window.geofs.aircraft.instance.engines;
        if (eng && eng[0] && getAbThrust(eng[0]) > 0) return 'generic-fighter';
        return null;
    }

    function getFuelCapacity() {
        const acType = detectAircraftType();
        if (acType && FIGHTER_FUEL_DB[acType]) return FIGHTER_FUEL_DB[acType].capacity;
        const mass = window.geofs.aircraft.instance.definition.mass;
        return Math.round(mass * 0.28);
    }

    // ──────────────────────────────────────────────────────────
    // AFTERBURNER DETECTION
    // GeoFS aircraft use several different property names.
    // We try each in priority order before falling back to the
    // throttle-threshold heuristic.
    // ──────────────────────────────────────────────────────────

    function getAbThrust(engine) {
        return engine.afterBurnerThrust || engine.afterburnerThrust || 0;
    }

    function hasAfterburner(engines) {
        const e = engines[0];
        return (e.afterBurnerThrust != null && e.afterBurnerThrust > 0) ||
               (e.afterburnerThrust != null && e.afterburnerThrust > 0);
    }

    function isAbActive(engines, throttle) {
        if (!hasAfterburner(engines)) return false;
        const e = engines[0];
        if (e.afterburnerLit !== null && e.afterburnerLit !== undefined) return !!e.afterburnerLit;
        if (e.afterburnerOn  !== null && e.afterburnerOn  !== undefined) return !!e.afterburnerOn;
        if (e.abLit          !== null && e.abLit          !== undefined) return !!e.abLit;
        if (e.abOn           !== null && e.abOn           !== undefined) return !!e.abOn;
        if (typeof e.afterburner === 'boolean') return e.afterburner;
        // Thrust-ratio method
        const dry  = e.thrust || 0;
        const live = e.currentThrust || e.outputThrust || 0;
        if (dry > 0 && live > dry * 1.05) return true;
        // Fallback: throttle threshold
        return throttle > 0.9;
    }

    // ──────────────────────────────────────────────────────────
    // BURN RATE
    // Returns 0 when engine is off, so both consumption and the
    // HUD display are always consistent.
    // ──────────────────────────────────────────────────────────

    function calculateBurnRate() {
        const instance = window.geofs.aircraft.instance;
        if (!instance.engine || !instance.engine.on) return 0;
        const engines = instance.engines;
        if (!engines || engines.length === 0) return 0;

        const throttle        = Math.abs(window.geofs.animation.values.smoothThrottle || 0);
        const totalDryThrust  = engines.reduce((s, e) => s + (e.thrust        || 0), 0);
        const totalAbThrust   = engines.reduce((s, e) => s + getAbThrust(e),          0);
        const abActive        = isAbActive(engines, throttle);
        const idleBurnRate    = totalDryThrust / 120;
        const fullMilBurnRate = totalDryThrust / 15;

        if (abActive && totalAbThrust > 0) {
            const abRatio = totalAbThrust / totalDryThrust;
            return fullMilBurnRate * (1 + (abRatio - 1) * 1.5) * throttle;
        }
        return idleBurnRate + throttle * (fullMilBurnRate - idleBurnRate);
    }

    // Conservative cruise burn estimate used for RTB fuel planning.
    // Uses actual burn rate when available, capped at 115 % of 55 % mil power.
    function getPlanningBurnRate() {
        const engines = window.geofs.aircraft.instance.engines || [];
        if (!engines.length) return 0;
        const totalDry   = engines.reduce((s, e) => s + (e.thrust || 0), 0);
        const idle       = totalDry / 120;
        const milMax     = totalDry / 15;
        const cruiseEst  = idle + 0.55 * (milMax - idle);
        const actual     = calculateBurnRate();
        return actual > 0 ? Math.min(actual, cruiseEst * 1.15) : cruiseEst;
    }

    // ──────────────────────────────────────────────────────────
    // POSITION & NAVIGATION
    // ──────────────────────────────────────────────────────────

    function getAircraftPosition() {
        const inst = window.geofs.aircraft.instance;
        const lla  = inst.llaLocation || inst.location || inst.lla;
        if (lla && lla.length >= 2) return { lat: +lla[0], lon: +lla[1], alt: +(lla[2] || 0) };
        if (inst.lat != null)       return { lat: +inst.lat, lon: +inst.lon, alt: +(inst.altitude || 0) };
        return null;
    }

    function toRad(d) { return d * Math.PI / 180; }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R    = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a    = Math.sin(dLat / 2) ** 2 +
                     Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Returns the nearest base object (with .dist added) or null.
    function getNearestBase(pos) {
        if (!settings.bases.length || !pos) return null;
        let nearest = null, minDist = Infinity;
        settings.bases.forEach((b, i) => {
            const d = haversineKm(pos.lat, pos.lon, b.lat, b.lon);
            if (d < minDist) { minDist = d; nearest = Object.assign({}, b, { index: i, dist: d }); }
        });
        return nearest;
    }

    // Returns manually-selected base.
    function getSelectedBase(pos) {
        if (!settings.bases.length) return null;
        const idx = Math.max(0, Math.min(settings.selectedBaseIndex, settings.bases.length - 1));
        const b   = settings.bases[idx];
        const d   = pos ? haversineKm(pos.lat, pos.lon, b.lat, b.lon) : 0;
        return Object.assign({}, b, { index: idx, dist: d });
    }

    // Main entry point: returns the active base based on mode.
    function getActiveBase(pos) {
        return settings.autoNearestBase ? getNearestBase(pos) : getSelectedBase(pos);
    }

    // Returns dynamic bingo data object or null.
    function calculateDynamicBingo() {
        if (!settings.dynamicBingoEnabled) return null;
        const pos  = getAircraftPosition();
        const base = getActiveBase(pos);
        if (!pos || !base) return null;
        const distKm       = base.dist;
        const planBurn     = getPlanningBurnRate();
        if (planBurn <= 0 || settings.cruiseSpeedKmh <= 0) return null;
        const travelHours  = distKm / settings.cruiseSpeedKmh;
        const reserveHours = settings.reserveMinutes / 60;
        const bingoFuel    = (travelHours + reserveHours) * planBurn;
        return {
            baseName:    base.name,
            distanceKm:  distKm,
            bingoFuel:   Math.min(fuelState.maxFuel, Math.max(0, bingoFuel))
        };
    }

    // ──────────────────────────────────────────────────────────
    // SETTINGS PANEL
    // ──────────────────────────────────────────────────────────

    function openSettings() {
        const existing = document.getElementById('geofs-fuel-settings');
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.id = 'geofs-fuel-settings';
        panel.style.cssText = [
            'position:fixed;right:16px;top:16px;width:300px',
            'background:rgba(5,5,5,0.96)',
            'border:1px solid rgba(0,255,136,0.3)',
            'border-radius:10px;z-index:10000',
            'color:#00ff88;font-family:monospace;font-size:12px',
            'box-shadow:0 8px 30px rgba(0,0,0,0.4)'
        ].join(';');

        panel.innerHTML = buildSettingsHTML();
        document.body.appendChild(panel);
        bindSettingsEvents(panel);
    }

    function buildSettingsHTML() {
        const baseOptions = settings.bases
            .map((b, i) => '<option value="' + i + '"' + (i === settings.selectedBaseIndex ? ' selected' : '') + '>' + b.name + '</option>')
            .join('');
        const inputStyle = 'background:#111;color:#00ff88;border:1px solid rgba(0,255,136,0.25);border-radius:6px;padding:6px;width:100%;box-sizing:border-box;font-family:monospace;';
        const rowStyle   = 'display:grid;gap:4px;';

        return '<div style="padding:10px 12px;border-bottom:1px solid rgba(0,255,136,0.15);display:flex;justify-content:space-between;align-items:center;">'
            +    '<span style="letter-spacing:1px;">\u2708 FUEL SETTINGS <span style="color:#555;font-size:9px;">v' + VERSION + '</span></span>'
            +    '<button id="fuel-settings-close" style="color:#ff7777;cursor:pointer;background:none;border:none;font:inherit;">✕</button>'
            + '</div>'
            + '<div style="padding:12px;display:grid;gap:10px;">'

            // Dynamic bingo toggle
            + '<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;">'
            +   '<span>Dynamic RTB bingo</span>'
            +   '<input id="fuel-dynbingo-toggle" type="checkbox"' + (settings.dynamicBingoEnabled ? ' checked' : '') + '>'
            + '</label>'

            // Auto nearest base toggle
            + '<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;">'
            +   '<span>Auto nearest base</span>'
            +   '<input id="fuel-autonear-toggle" type="checkbox"' + (settings.autoNearestBase ? ' checked' : '') + '>'
            + '</label>'

            // Manual base selector (shown only if auto is off)
            + '<div id="fuel-manual-base-row" style="' + rowStyle + (settings.autoNearestBase ? 'display:none;' : '') + '">'
            +   '<span>Selected base</span>'
            +   '<select id="fuel-base-select" style="' + inputStyle + '">'
            +     (baseOptions || '<option value="">No saved bases</option>')
            +   '</select>'
            + '</div>'

            // Reserve minutes
            + '<label style="' + rowStyle + '">'
            +   '<span>Reserve (minutes)</span>'
            +   '<input id="fuel-reserve-min" type="number" min="0" value="' + settings.reserveMinutes + '" style="' + inputStyle + '">'
            + '</label>'

            // Cruise speed
            + '<label style="' + rowStyle + '">'
            +   '<span>Planning cruise speed (km/h)</span>'
            +   '<input id="fuel-cruise-speed" type="number" min="100" value="' + settings.cruiseSpeedKmh + '" style="' + inputStyle + '">'
            + '</label>'

            // Add base button
            + '<button id="fuel-add-base" style="padding:8px;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3);border-radius:6px;color:#00ff88;cursor:pointer;font-family:monospace;">+ Add current position as base</button>'

            // Base list
            + '<div id="fuel-base-list" style="max-height:120px;overflow:auto;border:1px solid rgba(0,255,136,0.1);border-radius:6px;padding:6px;background:#0a0a0a;">'
            +   buildBaseListHTML()
            + '</div>'

            + '</div>';
    }

    function buildBaseListHTML() {
        if (!settings.bases.length) return '<div style="color:#555;">No bases saved</div>';
        return settings.bases.map((b, i) =>
            '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 2px;' +
            (i < settings.bases.length - 1 ? 'border-bottom:1px solid rgba(0,255,136,0.08);' : '') + '">'
            + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + b.name + '</span>'
            + '<button data-base-remove="' + i + '" style="color:#ff7777;cursor:pointer;background:none;border:none;font:inherit;">DEL</button>'
            + '</div>'
        ).join('');
    }

    function rebuildSettings(panel) {
        panel.remove();
        openSettings();
    }

    function bindSettingsEvents(panel) {
        panel.querySelector('#fuel-settings-close').onclick = () => panel.remove();

        panel.querySelector('#fuel-dynbingo-toggle').onchange = e => {
            settings.dynamicBingoEnabled = e.target.checked;
        };

        panel.querySelector('#fuel-autonear-toggle').onchange = e => {
            settings.autoNearestBase = e.target.checked;
            const manualRow = panel.querySelector('#fuel-manual-base-row');
            if (manualRow) manualRow.style.display = settings.autoNearestBase ? 'none' : 'grid';
        };

        panel.querySelector('#fuel-base-select').onchange = e => {
            settings.selectedBaseIndex = Number(e.target.value || 0);
        };

        panel.querySelector('#fuel-reserve-min').onchange = e => {
            settings.reserveMinutes = Math.max(0, Number(e.target.value || 10));
        };

        panel.querySelector('#fuel-cruise-speed').onchange = e => {
            settings.cruiseSpeedKmh = Math.max(100, Number(e.target.value || 900));
        };

        panel.querySelector('#fuel-add-base').onclick = () => {
            const pos  = getAircraftPosition();
            if (!pos) { console.warn('[Fuel] Position unavailable'); return; }
            const name = prompt('Base name / ICAO?', 'BASE ' + (settings.bases.length + 1));
            if (!name) return;
            settings.bases.push({ name: name.trim(), lat: pos.lat, lon: pos.lon });
            settings.selectedBaseIndex = settings.bases.length - 1;
            console.log('[Fuel] Base added:', name.trim(), pos.lat.toFixed(4), pos.lon.toFixed(4));
            rebuildSettings(panel);
        };

        panel.addEventListener('click', e => {
            const btn = e.target.closest('[data-base-remove]');
            if (!btn) return;
            const idx = Number(btn.getAttribute('data-base-remove'));
            settings.bases.splice(idx, 1);
            if (settings.selectedBaseIndex >= settings.bases.length)
                settings.selectedBaseIndex = Math.max(0, settings.bases.length - 1);
            rebuildSettings(panel);
        });
    }

    // ──────────────────────────────────────────────────────────
    // HUD
    // ──────────────────────────────────────────────────────────

    function setupDrag(hud) {
        const handle = document.getElementById('fuel-drag-handle');
        if (!handle) return;
        handle.addEventListener('mousedown', e => {
            isDragging  = true;
            const rect  = hud.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            handle.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            hudLeft = Math.max(0, Math.min(window.innerWidth  - hud.offsetWidth,  e.clientX - dragOffsetX));
            hudTop  = Math.max(0, Math.min(window.innerHeight - hud.offsetHeight, e.clientY - dragOffsetY));
            hud.style.left   = hudLeft + 'px';
            hud.style.top    = hudTop  + 'px';
            hud.style.right  = 'auto';
            hud.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; handle.style.cursor = 'grab'; }
        });
    }

    function createHUD() {
        const existing = document.getElementById('geofs-fuel-hud');
        if (existing) existing.remove();

        const hud      = document.createElement('div');
        hud.id         = 'geofs-fuel-hud';
        const posStyle = (hudLeft !== null && hudTop !== null)
            ? 'left:' + hudLeft + 'px;top:' + hudTop + 'px;'
            : 'right:16px;bottom:60px;';

        hud.style.cssText = 'position:fixed;' + posStyle
            + 'width:252px;background:rgba(0,0,0,0.9);'
            + 'border:1px solid rgba(0,255,136,0.35);border-radius:10px;'
            + 'z-index:9999;font-family:monospace;font-size:12px;color:#00ff88;'
            + 'user-select:none;box-shadow:0 4px 24px rgba(0,255,100,0.12);';

        hud.innerHTML = ''
            // ── Title bar / drag handle ──
            + '<div id="fuel-drag-handle" title="Drag to move"'
            +   ' style="padding:8px 12px 6px;cursor:grab;border-bottom:1px solid rgba(0,255,136,0.15);'
            +          'display:flex;justify-content:space-between;align-items:center;'
            +          'background:rgba(0,255,136,0.06);border-radius:10px 10px 0 0;gap:6px;">'
            +   '<span style="font-size:10px;color:#00ff88;letter-spacing:2px;flex-shrink:0;">\u2708 FUEL SYS</span>'
            +   '<span id="fuel-ac-name" style="font-size:9px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;">--</span>'
            + '</div>'
            // ── Body ──
            + '<div style="padding:10px 12px;">'
            +   '<div id="fuel-pct" style="font-size:28px;font-weight:bold;text-align:center;margin-bottom:4px;">100%</div>'
            +   '<div style="width:100%;height:12px;background:#111;border-radius:6px;overflow:hidden;margin-bottom:6px;">'
            +     '<div id="fuel-bar" style="height:100%;width:100%;background:#22c55e;border-radius:6px;transition:all 0.3s;"></div>'
            +   '</div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px;">'
            +     '<span>FUEL: <span id="fuel-kg">0</span> kg</span>'
            +     '<span>BURN: <span id="burn-rate">0</span> kg/hr</span>'
            +   '</div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:10px;">'
            +     '<span>ENDUR: <span id="endurance">--</span></span>'
            +     '<span>AB: <span id="ab-status" style="color:#ff8800;">OFF</span></span>'
            +   '</div>'
            // ── Dynamic bingo section (hidden until enabled + base saved) ──
            +   '<div id="dynamic-bingo-box" style="margin-top:6px;padding-top:6px;'
            +     'border-top:1px solid rgba(0,255,136,0.12);font-size:10px;display:none;">'
            +     '<div style="display:flex;justify-content:space-between;">'
            +       '<span>RTB BINGO:</span><span id="dynamic-bingo-fuel" style="color:#eab308;">--</span>'
            +     '</div>'
            +     '<div style="display:flex;justify-content:space-between;">'
            +       '<span>BASE:</span><span id="dynamic-bingo-base" style="color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">--</span>'
            +     '</div>'
            +     '<div style="display:flex;justify-content:space-between;">'
            +       '<span>DIST:</span><span id="dynamic-bingo-dist">--</span>'
            +     '</div>'
            +   '</div>'
            // ── Warning ──
            +   '<div id="fuel-warn" style="text-align:center;margin-top:4px;font-size:10px;font-weight:bold;color:#ff2244;display:none;">\u26a0 LOW FUEL</div>'
            // ── Buttons ──
            +   '<div style="display:flex;gap:6px;margin-top:8px;">'
            +     '<button id="geofs-refuel-btn"'
            +       ' style="flex:1;padding:6px 0;background:rgba(234,179,8,0.15);'
            +              'border:1px solid rgba(234,179,8,0.4);border-radius:6px;'
            +              'color:#eab308;font-family:monospace;font-size:11px;cursor:pointer;display:none;">'
            +       '\u26fd REFUEL'
            +     '</button>'
            +     '<button id="geofs-settings-btn"'
            +       ' style="padding:6px 10px;background:rgba(0,255,136,0.1);'
            +              'border:1px solid rgba(0,255,136,0.3);border-radius:6px;'
            +              'color:#00ff88;font-family:monospace;font-size:11px;cursor:pointer;">'
            +       'SET'
            +     '</button>'
            +   '</div>'
            + '</div>';

        document.body.appendChild(hud);
        document.getElementById('geofs-refuel-btn').onclick  = doRefuel;
        document.getElementById('geofs-settings-btn').onclick = openSettings;
        setupDrag(hud);
    }

    function updateHUD() {
        const hud = document.getElementById('geofs-fuel-hud');
        if (!hud) return;
        if (!hudVisible) { hud.style.display = 'none'; return; }
        hud.style.display = 'block';

        const pct      = (fuelState.fuel / fuelState.maxFuel) * 100;
        const burnRate = calculateBurnRate();
        const throttle = Math.abs(window.geofs.animation.values.smoothThrottle || 0);
        const engines  = window.geofs.aircraft.instance.engines;
        const abActive = isAbActive(engines, throttle);
        const acType   = detectAircraftType();
        const acData   = acType && FIGHTER_FUEL_DB[acType];

        // Aircraft name
        const acNameEl = document.getElementById('fuel-ac-name');
        if (acNameEl) acNameEl.textContent = acData
            ? acData.name
            : (window.geofs.aircraft.instance.aircraftRecord.name || '--');

        // Percentage + colour
        const pctColor = pct > 25 ? '#22c55e' : pct > 10 ? '#eab308' : '#ef4444';
        const pctEl    = document.getElementById('fuel-pct');
        if (pctEl) { pctEl.textContent = pct.toFixed(1) + '%'; pctEl.style.color = pctColor; }

        // Fuel bar
        const bar = document.getElementById('fuel-bar');
        if (bar) { bar.style.width = pct + '%'; bar.style.background = pctColor; }

        // kg remaining
        const kgEl = document.getElementById('fuel-kg');
        if (kgEl) kgEl.textContent = fuelState.fuel.toFixed(0);

        // Burn rate
        const brEl = document.getElementById('burn-rate');
        if (brEl) brEl.textContent = burnRate.toFixed(0);

        // Endurance
        const endEl = document.getElementById('endurance');
        if (endEl) {
            if (burnRate > 0) {
                const h = fuelState.fuel / burnRate;
                endEl.textContent = h >= 1 ? h.toFixed(1) + 'h' : (h * 60).toFixed(0) + 'm';
            } else { endEl.textContent = '--'; }
        }

        // Afterburner status
        const abEl = document.getElementById('ab-status');
        if (abEl) { abEl.textContent = abActive ? 'ON' : 'OFF'; abEl.style.color = abActive ? '#ff4400' : '#ff8800'; }

        // Dynamic RTB bingo section
        const dyn    = calculateDynamicBingo();
        const dynBox = document.getElementById('dynamic-bingo-box');
        if (dynBox) dynBox.style.display = dyn ? 'block' : 'none';
        if (dyn) {
            const dfEl = document.getElementById('dynamic-bingo-fuel');
            const dbEl = document.getElementById('dynamic-bingo-base');
            const ddEl = document.getElementById('dynamic-bingo-dist');
            if (dfEl) dfEl.textContent = dyn.bingoFuel.toFixed(0) + ' kg';
            if (dbEl) dbEl.textContent = dyn.baseName;
            if (ddEl) ddEl.textContent = dyn.distanceKm.toFixed(0) + ' km';
        }

        // Warning banner — RTB bingo takes priority over fixed-pct bingo
        const warnEl = document.getElementById('fuel-warn');
        if (warnEl) {
            const rtbTriggered = dyn && fuelState.fuel <= dyn.bingoFuel;
            if (pct <= 10) {
                warnEl.style.display  = 'block';
                warnEl.textContent    = '\ud83d\udea8 CRITICAL FUEL';
            } else if (rtbTriggered) {
                warnEl.style.display  = 'block';
                warnEl.textContent    = '\u26a0 RETURN FUEL MIN';
                warnEl.style.color    = '#ffaa00';
            } else if (pct <= 25) {
                warnEl.style.display  = 'block';
                warnEl.textContent    = '\u26a0 BINGO FUEL';
                warnEl.style.color    = '#ff2244';
            } else {
                warnEl.style.display  = 'none';
                warnEl.style.color    = '#ff2244';
            }
        }

        // Refuel button (visible on ground, engine off, stationary)
        const refuelBtn = document.getElementById('geofs-refuel-btn');
        if (refuelBtn) {
            const og = window.geofs.aircraft.instance.groundContact;
            const eo = window.geofs.aircraft.instance.engine.on;
            const gs = window.geofs.aircraft.instance.groundSpeed;
            refuelBtn.style.display = (og && !eo && gs < 1) ? 'block' : 'none';
        }
    }

    // ──────────────────────────────────────────────────────────
    // REFUEL
    // ──────────────────────────────────────────────────────────

    function doRefuel() {
        const onGround = window.geofs.aircraft.instance.groundContact;
        const engineOn = window.geofs.aircraft.instance.engine.on;
        const gs       = window.geofs.aircraft.instance.groundSpeed;
        if (onGround && !engineOn && gs < 1) {
            fuelState.fuel = fuelState.maxFuel;
            console.log('[Fuel] Refueled to full: ' + fuelState.maxFuel + ' kg');
        } else if (!onGround) {
            console.warn('[Fuel] Cannot refuel: not on ground');
        } else {
            console.warn('[Fuel] Cannot refuel: engine must be off and aircraft stationary');
        }
    }

    // ──────────────────────────────────────────────────────────
    // INIT & UPDATE LOOP
    // ──────────────────────────────────────────────────────────

    function initFuel() {
        const id = window.geofs.aircraft.instance.aircraftRecord.id;
        if (fuelState.lastAircraft !== id || !fuelState.initialized) {
            fuelState.maxFuel      = getFuelCapacity();
            fuelState.fuel         = fuelState.maxFuel;
            fuelState.lastAircraft = id;
            fuelState.initialized  = true;
            console.log('[Fuel v' + VERSION + '] ' + detectAircraftType() + ' | Capacity: ' + fuelState.maxFuel + ' kg');
            createHUD();
        }
    }

    function fuelUpdate() {
        if (window.geofs.pause || document.hidden) return;
        initFuel();
        const engineOn = window.geofs.aircraft.instance.engine.on;
        if (engineOn && fuelState.fuel > 0) {
            fuelState.fuel = Math.max(0, fuelState.fuel - calculateBurnRate() / 3600);
            if (fuelState.fuel <= 0) {
                window.geofs.aircraft.instance.stopEngine();
                console.warn('[Fuel] FUEL EXHAUSTED — engine shutdown');
            }
        }
        updateHUD();
    }

    // ──────────────────────────────────────────────────────────
    // KEYBOARD SHORTCUTS
    // ──────────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.key === 'h' || e.key === 'H') hudVisible = !hudVisible;
    });

    // ──────────────────────────────────────────────────────────
    // START
    // ──────────────────────────────────────────────────────────
    console.log('[GeoFS Fuel System v' + VERSION + '] Loaded from GitHub. H = toggle HUD | SET = settings');
    setInterval(fuelUpdate, 1000);
    setInterval(() => {
        if (window.geofs.aircraft.instance.aircraftRecord.id !== fuelState.lastAircraft)
            fuelState.initialized = false;
    }, 2000);

})();
