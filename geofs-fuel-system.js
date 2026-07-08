// ==============================================================
// GeoFS Fighter Jet Realistic Fuel System
// Version: 4.2.0 (with F-35B tuned burn & refuel fixes)
// Repository: https://github.com/GeoFSflyer/Geofs-fuel-system
// ==============================================================

(function () {
    'use strict';

    const VERSION           = '4.2.0';
    const TICK_MS           = 200;         // update interval — 5 Hz
    const TICK_S            = TICK_MS / 1000;
    const REFUEL_DURATION_S = 45;         // seconds to fill from 0 → 100 %

    // ── Aircraft fuel database ────────────────────────────────
    const FIGHTER_FUEL_DB = {
        'f-16':        { capacity:  3175, engines: 1, name: 'F-16 Fighting Falcon'  },
        'f/a-18f':     { capacity:  6532, engines: 2, name: 'F/A-18F Super Hornet'  },
        'f-14':        { capacity:  7348, engines: 2, name: 'F-14B Tomcat'          },
        'f-15':        { capacity:  6103, engines: 2, name: 'F-15C Eagle'           },
        'f-22':        { capacity:  8200, engines: 2, name: 'F-22 Raptor'           },
        // F-35B internal fuel ≈ 6125 kg (13,500 lb) — already realistic
        'f-35':        { capacity:  6125, engines: 1, name: 'F-35B Lightning II'    },
        'yf-23':       { capacity:  8600, engines: 2, name: 'YF-23'                 },
        'su-35':       { capacity: 11500, engines: 2, name: 'Su-35'                 },
        'rafale':      { capacity:  4700, engines: 2, name: 'Dassault Rafale'       },
        'mirage f1':   { capacity:  4300, engines: 1, name: 'Mirage F1'             },
        'mirage 2000': { capacity:  3978, engines: 1, name: 'Mirage 2000-5'         },
        'j-20':        { capacity: 11340, engines: 2, name: 'Chengdu J-20'          },
        'a-10':        { capacity:  4853, engines: 2, name: 'A-10C Thunderbolt II'  },
        'alpha':       { capacity:  1900, engines: 2, name: 'Alpha Jet'             },
        't-38':        { capacity:  1540, engines: 2, name: 'T-38 Talon'            }
    };

    // ── State ─────────────────────────────────────────────────
    let fuelState = {
        fuel:             0,
        maxFuel:          0,
        initialized:      false,
        lastAircraft:     null,
        // Refuelling
        refuelling:       false,
        refuelStartFuel:  0,
        refuelStartTime:  null,
        refuelDuration:   REFUEL_DURATION_S
    };

    let hudVisible  = true;
    let isDragging  = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let hudLeft     = null, hudTop = null;

    // ── Settings ──────────────────────────────────────────────
    const settings = {
        dynamicBingoEnabled: false,
        autoNearestBase:     true,
        reserveMinutes:      10,
        cruiseSpeedKmh:      900,
        refuelDuration:      REFUEL_DURATION_S,  // user-adjustable in settings
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
    // AFTERburner DETECTION
    // ──────────────────────────────────────────────────────────
    function getAbThrust(engine) {
        return engine.afterBurnerThrust || engine.afterburnerThrust || 0;
    }

    function hasAfterburner(engines) {
        const e = engines[0];
        return (e.afterBurnerThrust  != null && e.afterBurnerThrust  > 0) ||
               (e.afterburnerThrust  != null && e.afterburnerThrust  > 0);
    }

    function isAbActive(engines, throttle) {
        if (!hasAfterburner(engines)) return false;
        const e = engines[0];
        // Named flags first (most reliable)
        if (e.afterburnerLit != null) return !!e.afterburnerLit;
        if (e.afterburnerOn  != null) return !!e.afterburnerOn;
        if (e.abLit          != null) return !!e.abLit;
        if (e.abOn           != null) return !!e.abOn;
        if (typeof e.afterburner === 'boolean') return e.afterburner;
        // Thrust-ratio method
        const dry  = e.thrust || 0;
        const live = e.currentThrust || e.outputThrust || 0;
        if (dry > 0 && live > dry * 1.05) return true;
        // Throttle-threshold fallback
        return throttle > 0.9;
    }

    // ──────────────────────────────────────────────────────────
    // BURN RATE  (kg / hr) — tuned mil vs AB
    // ──────────────────────────────────────────────────────────
    function calculateBurnRate() {
        const instance = window.geofs.aircraft.instance;
        if (!instance.engine || !instance.engine.on) return 0;
        const engines = instance.engines;
        if (!engines || engines.length === 0) return 0;

        const throttle        = Math.abs(window.geofs.animation.values.smoothThrottle || 0);
        const totalDryThrust  = engines.reduce((s, e) => s + (e.thrust || 0), 0);
        const totalAbThrust   = engines.reduce((s, e) => s + getAbThrust(e), 0);
        const abActive        = isAbActive(engines, throttle);

        // Tunable ratios:
        // - idleFractionOfMil: idle fuel ≈ 8% of mil
        // - abFactorOverMil: AB burns ~60% more fuel than mil
        const idleFractionOfMil = 0.08;
        const abFactorOverMil   = 1.6;

        // Full mil burn tied to total dry thrust:
        // Using /22 instead of /15 gives longer endurance at mil power.
        const fullMilBurnRate = totalDryThrust / 22;
        const idleBurnRate    = fullMilBurnRate * idleFractionOfMil;

        if (abActive && totalAbThrust > 0) {
            const abBurnRate = fullMilBurnRate * abFactorOverMil;
            // Blend AB in only near the top of the throttle range
            const abBlend = Math.max(0, throttle - 0.85) / 0.15; // 0 at 0.85, 1 at 1.0
            return idleBurnRate +
                   (fullMilBurnRate - idleBurnRate) * throttle +
                   (abBurnRate - fullMilBurnRate) * abBlend;
        }

        // Dry operation (idle → mil)
        return idleBurnRate + throttle * (fullMilBurnRate - idleBurnRate);
    }

    function getPlanningBurnRate() {
        const engines = window.geofs.aircraft.instance.engines || [];
        if (!engines.length) return 0;
        const totalDry  = engines.reduce((s, e) => s + (e.thrust || 0), 0);
        const idleFractionOfMil = 0.08;
        const fullMilBurnRate   = totalDry / 22;
        const idle              = fullMilBurnRate * idleFractionOfMil;
        const cruiseEst         = idle + 0.55 * (fullMilBurnRate - idle);
        const actual            = calculateBurnRate();
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

    function getNearestBase(pos) {
        if (!settings.bases.length || !pos) return null;
        let nearest = null, minDist = Infinity;
        settings.bases.forEach((b, i) => {
            const d = haversineKm(pos.lat, pos.lon, b.lat, b.lon);
            if (d < minDist) { minDist = d; nearest = Object.assign({}, b, { index: i, dist: d }); }
        });
        return nearest;
    }

    function getSelectedBase(pos) {
        if (!settings.bases.length) return null;
        const idx = Math.max(0, Math.min(settings.selectedBaseIndex, settings.bases.length - 1));
        const b   = settings.bases[idx];
        const d   = pos ? haversineKm(pos.lat, pos.lon, b.lat, b.lon) : 0;
        return Object.assign({}, b, { index: idx, dist: d });
    }

    function getActiveBase(pos) {
        return settings.autoNearestBase ? getNearestBase(pos) : getSelectedBase(pos);
    }

    function calculateDynamicBingo() {
        if (!settings.dynamicBingoEnabled) return null;
        const pos  = getAircraftPosition();
        const base = getActiveBase(pos);
        if (!pos || !base) return null;
        const planBurn = getPlanningBurnRate();
        if (planBurn <= 0 || settings.cruiseSpeedKmh <= 0) return null;
        const travelHours  = base.dist / settings.cruiseSpeedKmh;
        const reserveHours = settings.reserveMinutes / 60;
        const bingoFuel    = (travelHours + reserveHours) * planBurn;
        return {
            baseName:   base.name,
            distanceKm: base.dist,
            bingoFuel:  Math.min(fuelState.maxFuel, Math.max(0, bingoFuel))
        };
    }

    // ──────────────────────────────────────────────────────────
    // REFUELLING
    // ──────────────────────────────────────────────────────────
    function canRefuel() {
        const inst = window.geofs.aircraft.instance;
        return inst.groundContact && !inst.engine.on && inst.groundSpeed < 1;
    }

    function startRefuel() {
        if (!canRefuel()) {
            if (!window.geofs.aircraft.instance.groundContact) {
                console.warn('[Fuel] Cannot refuel: not on ground');
            } else if (window.geofs.aircraft.instance.engine.on) {
                console.warn('[Fuel] Cannot refuel: engine must be off');
            } else {
                console.warn('[Fuel] Cannot refuel: aircraft must be stationary');
            }
            return;
        }
        if (fuelState.refuelling) {
            // Clicking again cancels
            cancelRefuel();
            return;
        }
        if (fuelState.fuel >= fuelState.maxFuel) {
            console.log('[Fuel] Tank already full');
            return;
        }
        fuelState.refuelling      = true;
        fuelState.refuelStartFuel = fuelState.fuel;
        fuelState.refuelStartTime = Date.now();
        fuelState.refuelDuration  = settings.refuelDuration; // lock duration for this cycle
        console.log('[Fuel] Refuelling started — ' + fuelState.refuelDuration + 's to full');
    }

    function cancelRefuel() {
        if (!fuelState.refuelling) return;
        fuelState.refuelling      = false;
        fuelState.refuelStartFuel = 0;
        fuelState.refuelStartTime = null;
        console.log('[Fuel] Refuelling cancelled at ' + fuelState.fuel.toFixed(0) + ' kg');
    }

    function tickRefuel() {
        if (!fuelState.refuelling) return;

        // Abort conditions
        if (!canRefuel()) {
            cancelRefuel();
            return;
        }

        const elapsed  = (Date.now() - fuelState.refuelStartTime) / 1000;
        const duration = fuelState.refuelDuration;
        const target   = fuelState.maxFuel;
        const start    = fuelState.refuelStartFuel;

        const progress = Math.min(1, elapsed / duration);
        fuelState.fuel = start + progress * (target - start);

        if (progress >= 1) {
            fuelState.fuel       = target;
            fuelState.refuelling = false;
            console.log('[Fuel] Refuelling complete: ' + target + ' kg');
        }
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
        const inp = 'background:#111;color:#00ff88;border:1px solid rgba(0,255,136,0.25);border-radius:6px;padding:6px;width:100%;box-sizing:border-box;font-family:monospace;';
        const row = 'display:grid;gap:4px;';
        return '<div style="padding:10px 12px;border-bottom:1px solid rgba(0,255,136,0.15);display:flex;justify-content:space-between;align-items:center;">'
            +    '<span style="letter-spacing:1px;">\u2708 FUEL SETTINGS <span style="color:#555;font-size:9px;">v' + VERSION + '</span></span>'
            +    '<button id="fuel-settings-close" style="color:#ff7777;cursor:pointer;background:none;border:none;font:inherit;">✕</button>'
            + '</div>'
            + '<div style="padding:12px;display:grid;gap:10px;">'

            + '<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;">'
            +   '<span>Dynamic RTB bingo</span>'
            +   '<input id="fuel-dynbingo-toggle" type="checkbox"' + (settings.dynamicBingoEnabled ? ' checked' : '') + '>'
            + '</label>'

            + '<label style="display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;">'
            +   '<span>Auto nearest base</span>'
            +   '<input id="fuel-autonear-toggle" type="checkbox"' + (settings.autoNearestBase ? ' checked' : '') + '>'
            + '</label>'

            + '<div id="fuel-manual-base-row" style="' + row + (settings.autoNearestBase ? 'display:none;' : '') + '">'
            +   '<span>Selected base</span>'
            +   '<select id="fuel-base-select" style="' + inp + '">'
            +     (baseOptions || '<option value="">No saved bases</option>')
            +   '</select>'
            + '</div>'

            + '<label style="' + row + '">'
            +   '<span>Reserve (minutes)</span>'
            +   '<input id="fuel-reserve-min" type="number" min="0" value="' + settings.reserveMinutes + '" style="' + inp + '">'
            + '</label>'

            + '<label style="' + row + '">'
            +   '<span>Planning cruise speed (km/h)</span>'
            +   '<input id="fuel-cruise-speed" type="number" min="100" value="' + settings.cruiseSpeedKmh + '" style="' + inp + '">'
            + '</label>'

            + '<label style="' + row + '">'
            +   '<span>Refuel duration (seconds, 30–60)</span>'
            +   '<input id="fuel-refuel-dur" type="number" min="30" max="60" value="' + settings.refuelDuration + '" style="' + inp + '">'
            + '</label>'

            + '<button id="fuel-add-base" style="padding:8px;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3);border-radius:6px;color:#00ff88;cursor:pointer;font-family:monospace;">+ Add current position as base</button>'

            + '<div id="fuel-base-list" style="max-height:120px;overflow:auto;border:1px solid rgba(0,255,136,0.1);border-radius:6px;padding:6px;background:#0a0a0a;">'
            +   buildBaseListHTML()
            + '</div>'

            + '</div>';
    }

    function buildBaseListHTML() {
        if (!settings.bases.length) return '<div style="color:#555;">No bases saved</div>';
        return settings.bases.map((b, i) =>
            '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 2px;'
            + (i < settings.bases.length - 1 ? 'border-bottom:1px solid rgba(0,255,136,0.08);' : '') + '">'
            + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + b.name + '</span>'
            + '<button data-base-remove="' + i + '" style="color:#ff7777;cursor:pointer;background:none;border:none;font:inherit;">DEL</button>'
            + '</div>'
        ).join('');
    }

    function rebuildSettings(panel) { panel.remove(); openSettings(); }

    function bindSettingsEvents(panel) {
        panel.querySelector('#fuel-settings-close').onclick = () => panel.remove();
        panel.querySelector('#fuel-dynbingo-toggle').onchange  = e => { settings.dynamicBingoEnabled = e.target.checked; };
        panel.querySelector('#fuel-autonear-toggle').onchange  = e => {
            settings.autoNearestBase = e.target.checked;
            const r = panel.querySelector('#fuel-manual-base-row');
            if (r) r.style.display = settings.autoNearestBase ? 'none' : 'grid';
        };
        panel.querySelector('#fuel-base-select').onchange   = e => { settings.selectedBaseIndex = Number(e.target.value || 0); };
        panel.querySelector('#fuel-reserve-min').onchange   = e => { settings.reserveMinutes = Math.max(0, Number(e.target.value || 10)); };
        panel.querySelector('#fuel-cruise-speed').onchange  = e => { settings.cruiseSpeedKmh = Math.max(100, Number(e.target.value || 900)); };
        panel.querySelector('#fuel-refuel-dur').onchange    = e => { settings.refuelDuration  = Math.min(60, Math.max(30, Number(e.target.value || 45))); };
        panel.querySelector('#fuel-add-base').onclick = () => {
            const pos = getAircraftPosition();
            if (!pos) { console.warn('[Fuel] Position unavailable'); return; }
            const name = prompt('Base name / ICAO?', 'BASE ' + (settings.bases.length + 1));
            if (!name) return;
            settings.bases.push({ name: name.trim(), lat: pos.lat, lon: pos.lon });
            settings.selectedBaseIndex = settings.bases.length - 1;
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
            hud.style.left = hudLeft + 'px'; hud.style.top = hudTop + 'px';
            hud.style.right = 'auto'; hud.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (isDragging) { isDragging = false; handle.style.cursor = 'grab'; }
        });
    }

    function createHUD() {
        const existing = document.getElementById('geofs-fuel-hud');
        if (existing) existing.remove();
        const hud     = document.createElement('div');
        hud.id        = 'geofs-fuel-hud';
        const posCSS  = (hudLeft !== null && hudTop !== null)
            ? 'left:' + hudLeft + 'px;top:' + hudTop + 'px;'
            : 'right:16px;bottom:60px;';

        hud.style.cssText = 'position:fixed;' + posCSS
            + 'width:252px;background:rgba(0,0,0,0.9);'
            + 'border:1px solid rgba(0,255,136,0.35);border-radius:10px;'
            + 'z-index:9999;font-family:monospace;font-size:12px;color:#00ff88;'
            + 'user-select:none;box-shadow:0 4px 24px rgba(0,255,100,0.12);';

        hud.innerHTML = ''
            + '<div id="fuel-drag-handle" title="Drag to move"'
            +   ' style="padding:8px 12px 6px;cursor:grab;border-bottom:1px solid rgba(0,255,136,0.15);'
            +          'display:flex;justify-content:space-between;align-items:center;'
            +          'background:rgba(0,255,136,0.06);border-radius:10px 10px 0 0;gap:6px;">'
            +   '<span style="font-size:10px;color:#00ff88;letter-spacing:2px;flex-shrink:0;">\u2708 FUEL SYS</span>'
            +   '<span id="fuel-ac-name" style="font-size:9px;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;">--</span>'
            + '</div>'
            + '<div style="padding:10px 12px;">'
            +   '<div id="fuel-pct" style="font-size:28px;font-weight:bold;text-align:center;margin-bottom:4px;">100%</div>'
            +   '<div style="width:100%;height:12px;background:#111;border-radius:6px;overflow:hidden;margin-bottom:4px;">'
            +     '<div id="fuel-bar" style="height:100%;width:100%;background:#22c55e;border-radius:6px;transition:width 0.18s linear;"></div>'
            +   '</div>'
            +   '<div id="refuel-bar-wrap" style="width:100%;height:6px;background:#111;border-radius:6px;overflow:hidden;margin-bottom:6px;display:none;">'
            +     '<div id="refuel-bar" style="height:100%;width:0%;background:#eab308;border-radius:6px;transition:width 0.18s linear;"></div>'
            +   '</div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px;">'
            +     '<span>FUEL: <span id="fuel-kg">0</span> kg</span>'
            +     '<span>BURN: <span id="burn-rate">0</span> kg/hr</span>'
            +   '</div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:10px;">'
            +     '<span>ENDUR: <span id="endurance">--</span></span>'
            +     '<span>AB: <span id="ab-status" style="color:#ff8800;">OFF</span></span>'
            +   '</div>'
            +   '<div id="dynamic-bingo-box" style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,255,136,0.12);font-size:10px;display:none;">'
            +     '<div style="display:flex;justify-content:space-between;"><span>RTB BINGO:</span><span id="dynamic-bingo-fuel" style="color:#eab308;">--</span></div>'
            +     '<div style="display:flex;justify-content:space-between;"><span>BASE:</span><span id="dynamic-bingo-base" style="color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">--</span></div>'
            +     '<div style="display:flex;justify-content:space-between;"><span>DIST:</span><span id="dynamic-bingo-dist">--</span></div>'
            +   '</div>'
            +   '<div id="fuel-warn" style="text-align:center;margin-top:4px;font-size:10px;font-weight:bold;color:#ff2244;display:none;"></div>'
            +   '<div id="refuel-status" style="text-align:center;margin-top:4px;font-size:10px;color:#eab308;display:none;"></div>'
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
        document.getElementById('geofs-refuel-btn').onclick  = startRefuel;
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

        const acNameEl = document.getElementById('fuel-ac-name');
        if (acNameEl) acNameEl.textContent = acData
            ? acData.name
            : (window.geofs.aircraft.instance.aircraftRecord.name || '--');

        const pctColor = pct > 25 ? '#22c55e' : pct > 10 ? '#eab308' : '#ef4444';
        const pctEl    = document.getElementById('fuel-pct');
        if (pctEl) { pctEl.textContent = pct.toFixed(1) + '%'; pctEl.style.color = pctColor; }

        const bar = document.getElementById('fuel-bar');
        if (bar) { bar.style.width = pct + '%'; bar.style.background = pctColor; }

        const kgEl = document.getElementById('fuel-kg');
        if (kgEl) kgEl.textContent = fuelState.fuel.toFixed(0);

        const brEl = document.getElementById('burn-rate');
        if (brEl) brEl.textContent = burnRate.toFixed(0);

        const endEl = document.getElementById('endurance');
        if (endEl) {
            if (burnRate > 0) {
                const h = fuelState.fuel / burnRate;
                endEl.textContent = h >= 1 ? h.toFixed(1) + 'h' : (h * 60).toFixed(0) + 'm';
            } else { endEl.textContent = '--'; }
        }

        const abEl = document.getElementById('ab-status');
        if (abEl) { abEl.textContent = abActive ? 'ON' : 'OFF'; abEl.style.color = abActive ? '#ff4400' : '#ff8800'; }

        const rfWrap = document.getElementById('refuel-bar-wrap');
        const rfBar  = document.getElementById('refuel-bar');
        const rfStat = document.getElementById('refuel-status');
        if (fuelState.refuelling) {
            const elapsed  = (Date.now() - fuelState.refuelStartTime) / 1000;
            const progress = Math.min(1, elapsed / fuelState.refuelDuration) * 100;
            const secsLeft = Math.ceil(fuelState.refuelDuration - elapsed);
            if (rfWrap) rfWrap.style.display = 'block';
            if (rfBar)  rfBar.style.width     = progress + '%';
            if (rfStat) { rfStat.style.display = 'block'; rfStat.textContent = '\u26fd Fuelling… ' + secsLeft + 's'; }
        } else {
            if (rfWrap) rfWrap.style.display = 'none';
            if (rfStat) rfStat.style.display = 'none';
        }

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

        const warnEl = document.getElementById('fuel-warn');
        if (warnEl) {
            const rtbHit = dyn && fuelState.fuel <= dyn.bingoFuel;
            if (pct <= 10) {
                warnEl.style.display = 'block'; warnEl.style.color = '#ff2244';
                warnEl.textContent   = '\ud83d\udea8 CRITICAL FUEL';
            } else if (rtbHit) {
                warnEl.style.display = 'block'; warnEl.style.color = '#ffaa00';
                warnEl.textContent   = '\u26a0 RETURN FUEL MIN';
            } else if (pct <= 25) {
                warnEl.style.display = 'block'; warnEl.style.color = '#ff2244';
                warnEl.textContent   = '\u26a0 BINGO FUEL';
            } else {
                warnEl.style.display = 'none';
            }
        }

        const refuelBtn = document.getElementById('geofs-refuel-btn');
        if (refuelBtn) {
            const og = window.geofs.aircraft.instance.groundContact;
            const eo = window.geofs.aircraft.instance.engine.on;
            const gs = window.geofs.aircraft.instance.groundSpeed;
            const showBtn = og && !eo && gs < 1;
            refuelBtn.style.display = showBtn ? 'block' : 'none';
            refuelBtn.textContent   = fuelState.refuelling ? '\u26fd CANCEL' : '\u26fd REFUEL';
            refuelBtn.style.borderColor   = fuelState.refuelling ? 'rgba(255,100,0,0.5)' : 'rgba(234,179,8,0.4)';
            refuelBtn.style.color         = fuelState.refuelling ? '#ff6600'              : '#eab308';
        }
    }

    // ──────────────────────────────────────────────────────────
    // INIT & MAIN LOOP
    // ──────────────────────────────────────────────────────────
    function initFuel() {
        const inst = window.geofs.aircraft.instance;
        if (!inst || !inst.aircraftRecord) return;
        const id = inst.aircraftRecord.id;

        // Only reset capacity when aircraft ID truly changes
        if (fuelState.lastAircraft !== id || !fuelState.initialized) {
            fuelState.maxFuel      = getFuelCapacity();
            if (!fuelState.initialized || fuelState.lastAircraft !== id) {
                // On first load or true aircraft change, seed fuel to full
                fuelState.fuel = fuelState.maxFuel;
            }
            fuelState.lastAircraft = id;
            fuelState.initialized  = true;
            console.log('[Fuel v' + VERSION + '] ' + detectAircraftType() + ' | Capacity: ' + fuelState.maxFuel + ' kg');
        }

        // HUD can be recreated safely without touching fuel/refuel state
        if (!document.getElementById('geofs-fuel-hud')) {
            createHUD();
        }
    }

    function fuelUpdate() {
        if (window.geofs.pause || document.hidden) return;
        initFuel();

        tickRefuel();

        const engineOn = window.geofs.aircraft.instance.engine.on;
        if (engineOn && fuelState.fuel > 0 && !fuelState.refuelling) {
            const burned = (calculateBurnRate() / 3600) * TICK_S;
            fuelState.fuel = Math.max(0, fuelState.fuel - burned);
            if (fuelState.fuel <= 0) {
                window.geofs.aircraft.instance.stopEngine();
                console.warn('[Fuel] FUEL EXHAUSTED — engine shutdown');
            }
        }

        updateHUD();
    }

    document.addEventListener('keydown', e => {
        if (e.key === 'h' || e.key === 'H') hudVisible = !hudVisible;
    });

    console.log('[GeoFS Fuel System v' + VERSION + '] 5 Hz updates | Progressive refuel | H = toggle HUD');
    setInterval(fuelUpdate, TICK_MS);
    setInterval(() => {
        const inst = window.geofs.aircraft.instance;
        if (!inst || !inst.aircraftRecord) return;
        const id = inst.aircraftRecord.id;
        if (id !== fuelState.lastAircraft) {
            fuelState.initialized = false;
        }
    }, 2000);

})();
