// ==============================================================
// GeoFS Aircraft Realistic Fuel System (Fighters + Civilian)
// Version: 4.4.0 (Verified fuel data + civilian burn model + AB fix)
// ==============================================================

(function () {
    'use strict';

    const VERSION           = '4.4.0';
    const TICK_MS           = 200;         // update interval — 5 Hz
    const TICK_S            = TICK_MS / 1000;
    const REFUEL_DURATION_S = 45;         // seconds to fill from 0 → 100 %

    // ── Fighter fuel database (verified against Wikipedia / official fact sheets) ─
    // burnProfile: null => use thrust-based fighter formula (thrust/22 mil, x1.6 AB)
    const FIGHTER_FUEL_DB = {
        'f-16':        { capacity:  3175, engines: 1, name: 'F-16 Fighting Falcon',  hasAb: true,  burnProfile: null },
        'f/a-18f':     { capacity:  6568, engines: 2, name: 'F/A-18F Super Hornet',  hasAb: true,  burnProfile: null }, // corrected 6532 -> 6568 (14,480 lb JP-8)
        'f-14':        { capacity:  7348, engines: 2, name: 'F-14B Tomcat',          hasAb: true,  burnProfile: null },
        'f-15':        { capacity:  6103, engines: 2, name: 'F-15C Eagle',           hasAb: true,  burnProfile: null },
        'f-22':        { capacity:  8165, engines: 2, name: 'F-22 Raptor',           hasAb: true,  burnProfile: null }, // corrected 8200 -> 8165 (18,000 lb)
        'f-35':        { capacity:  6125, engines: 1, name: 'F-35B Lightning II',    hasAb: true,  burnProfile: null },
        'yf-23':       { capacity:  8600, engines: 2, name: 'YF-23',                 hasAb: true,  burnProfile: null },
        'su-35':       { capacity: 11500, engines: 2, name: 'Su-35',                 hasAb: true,  burnProfile: null },
        'rafale':      { capacity:  4700, engines: 2, name: 'Dassault Rafale',       hasAb: true,  burnProfile: null },
        // NOTE: Mirage figures below are UNVERIFIED in this pass. Commonly published specs list
        // Mirage F1 internal fuel as ~4300 L and Mirage 2000 as ~3978 L, not kg. If these were
        // copied directly from liters, they overstate true kg mass by roughly 20-25%
        // (Jet A/JP-8 density ~0.8 kg/L). Recommend confirming against a Dassault technical
        // manual before trusting these two entries.
        'mirage f1':   { capacity:  4300, engines: 1, name: 'Mirage F1',             hasAb: true,  burnProfile: null, unverified: true },
        'mirage 2000': { capacity:  3978, engines: 1, name: 'Mirage 2000-5',         hasAb: true,  burnProfile: null, unverified: true },
        'j-20':        { capacity: 11340, engines: 2, name: 'Chengdu J-20',          hasAb: true,  burnProfile: null, unverified: true },
        'a-10':        { capacity:  4990, engines: 2, name: 'A-10C Thunderbolt II',  hasAb: false, burnProfile: null }, // corrected 4853 -> 4990 (11,000 lb, no AB)
        'alpha':       { capacity:  1900, engines: 2, name: 'Alpha Jet',             hasAb: false, burnProfile: null, unverified: true },
        't-38':        { capacity:  1540, engines: 2, name: 'T-38 Talon',           hasAb: false, burnProfile: null, unverified: true }
    };

    // ── Civilian fuel database ──────────────────────────────────
    // burnProfile.idleKgHr / cruiseKgHr / maxKgHr are TOTAL across all engines,
    // sourced from manufacturer data / published performance figures where available.
    const CIVILIAN_FUEL_DB = {
        'a380':        { capacity: 253983, engines: 4, name: 'Airbus A380',
                          hasAb: false, burnProfile: { idleKgHr: 3600,  cruiseKgHr: 12000, maxKgHr: 16000 } }, // corrected 253000 -> 253983
        '737-700':     { capacity:  20800, engines: 2, name: 'Boeing 737-700',
                          hasAb: false, burnProfile: { idleKgHr: 700,   cruiseKgHr: 2400,  maxKgHr: 4200 } },
        'concorde':    { capacity:  95680, engines: 4, name: 'Concorde',
                          hasAb: false, burnProfile: { idleKgHr: 4000,  cruiseKgHr: 20500, maxKgHr: 26000 } }, // supersonic cruise ~20,500 kg/hr
        'a350':        { capacity: 109000, engines: 2, name: 'Airbus A350',
                          hasAb: false, burnProfile: { idleKgHr: 1400,  cruiseKgHr: 5400,  maxKgHr: 8500 } },
        '777-300er':   { capacity: 145000, engines: 2, name: 'Boeing 777-300ER',
                          hasAb: false, burnProfile: { idleKgHr: 1800,  cruiseKgHr: 7500,  maxKgHr: 11000 } },
        'piper cub':   { capacity:     32, engines: 1, name: 'Piper J-3 Cub',
                          hasAb: false, burnProfile: { idleKgHr: 4,     cruiseKgHr: 12,    maxKgHr: 16 } },
        'j-3 cub':     { capacity:     32, engines: 1, name: 'Piper J-3 Cub',
                          hasAb: false, burnProfile: { idleKgHr: 4,     cruiseKgHr: 12,    maxKgHr: 16 } },
        'cessna 172':  { capacity:    152, engines: 1, name: 'Cessna 172',
                          hasAb: false, burnProfile: { idleKgHr: 6,     cruiseKgHr: 24,    maxKgHr: 32 } }, // ~8-10 gal/hr cruise
        'phenom 100':  { capacity:   1272, engines: 2, name: 'Embraer Phenom 100',
                          hasAb: false, burnProfile: { idleKgHr: 120,   cruiseKgHr: 450,   maxKgHr: 700 } },
        'twin otter':  { capacity:    954, engines: 2, name: 'de Havilland DHC-6 Twin Otter',
                          hasAb: false, burnProfile: { idleKgHr: 80,    cruiseKgHr: 220,   maxKgHr: 340 }, unverified: true },
        'dhc6':        { capacity:    954, engines: 2, name: 'de Havilland DHC-6 Twin Otter',
                          hasAb: false, burnProfile: { idleKgHr: 80,    cruiseKgHr: 220,   maxKgHr: 340 }, unverified: true },
        'dhc-6':       { capacity:    954, engines: 2, name: 'de Havilland DHC-6 Twin Otter',
                          hasAb: false, burnProfile: { idleKgHr: 80,    cruiseKgHr: 220,   maxKgHr: 340 }, unverified: true },
        'pitts':       { capacity:     79, engines: 1, name: 'Pitts Special S1',
                          hasAb: false, burnProfile: { idleKgHr: 8,     cruiseKgHr: 30,    maxKgHr: 45 }, unverified: true },
        's1':          { capacity:     79, engines: 1, name: 'Pitts Special S1',
                          hasAb: false, burnProfile: { idleKgHr: 8,     cruiseKgHr: 30,    maxKgHr: 45 }, unverified: true },
        'ec135':       { capacity:    566, engines: 2, name: 'Eurocopter EC135',
                          hasAb: false, burnProfile: { idleKgHr: 90,    cruiseKgHr: 220,   maxKgHr: 320 } }, // corrected 700 -> 566 (708 L x ~0.8 kg/L)
        'ec-135':      { capacity:    566, engines: 2, name: 'Eurocopter EC135',
                          hasAb: false, burnProfile: { idleKgHr: 90,    cruiseKgHr: 220,   maxKgHr: 320 } }
    };

    // ── Combined lookup table used everywhere ──────────────────
@@ -88,14 +112,17 @@
        for (const key of Object.keys(AIRCRAFT_FUEL_DB)) {
            if (name.includes(key)) return key;
        }
        return null; // removed non-functional 'generic-fighter' fallback (was dead logic — no DB entry existed for it)


    }

    function getAircraftData() {
        const acType = detectAircraftType();
        return acType ? AIRCRAFT_FUEL_DB[acType] : null;
    }

    function getFuelCapacity() {
        const data = getAircraftData();
        if (data) return data.capacity;
        const mass = window.geofs.aircraft.instance.definition.mass;
        return Math.round(mass * 0.28);
    }
@@ -107,14 +134,19 @@
        return engine.afterBurnerThrust || engine.afterburnerThrust || 0;
    }

    // Aircraft "has an afterburner" if the DB explicitly says so, OR (for unknown
    // aircraft) the engine model itself reports non-zero AB thrust.
    function hasAfterburner(engines) {
        const data = getAircraftData();
        if (data) return !!data.hasAb;
        if (!engines || !engines.length) return false;
        const e = engines[0];
        return (e.afterBurnerThrust != null && e.afterBurnerThrust > 0) ||
               (e.afterburnerThrust != null && e.afterburnerThrust > 0);
    }

    function isAbActive(engines, throttle) {
        if (!hasAfterburner(engines)) return false;   // hard gate — fixes false "AB ON" on non-AB aircraft
        if (!engines || !engines.length) return false;
        const e = engines[0];

@@ -134,18 +166,33 @@
    }

    // ──────────────────────────────────────────────────────────
    // BURN RATE  (kg / hr)
    // Fighters (burnProfile === null): thrust-based mil/AB model.
    // Civilian/data-driven aircraft (burnProfile set): idle -> cruise -> max
    // kg/hr curve interpolated by throttle, sourced from real performance data.
    // ──────────────────────────────────────────────────────────
    function calculateBurnRate() {
        const instance = window.geofs.aircraft.instance;
        if (!instance.engine || !instance.engine.on) return 0;
        const engines = instance.engines;
        if (!engines || engines.length === 0) return 0;

        const throttle = Math.abs(window.geofs.animation.values.smoothThrottle || 0);
        const data     = getAircraftData();

        if (data && data.burnProfile) {
            const { idleKgHr, cruiseKgHr, maxKgHr } = data.burnProfile;
            if (throttle <= 0.7) {
                return idleKgHr + (throttle / 0.7) * (cruiseKgHr - idleKgHr);
            }
            const t = (throttle - 0.7) / 0.3;
            return cruiseKgHr + t * (maxKgHr - cruiseKgHr);
        }

        // Fallback: thrust-based fighter model
        const totalDryThrust  = engines.reduce((s, e) => s + (e.thrust || 0), 0);
        const totalAbThrust   = engines.reduce((s, e) => s + getAbThrust(e), 0);
        const abActive        = isAbActive(engines, throttle); // already gated by hasAfterburner()

        const idleFractionOfMil = 0.08;
        const abFactorOverMil   = 1.6;
@@ -165,6 +212,9 @@
    }

    function getPlanningBurnRate() {
        const data = getAircraftData();
        if (data && data.burnProfile) return data.burnProfile.cruiseKgHr;

        const engines = window.geofs.aircraft.instance.engines || [];
        if (!engines.length) return 0;
        const totalDry  = engines.reduce((s, e) => s + (e.thrust || 0), 0);
@@ -483,7 +533,7 @@
            +     '<span>FUEL: <span id="fuel-kg">0</span> kg</span>'
            +     '<span>BURN: <span id="burn-rate">0</span> kg/hr</span>'
            +   '</div>'
            +   '<div id="ab-row" style="display:flex;justify-content:space-between;font-size:10px;">'
            +     '<span>ENDUR: <span id="endurance">--</span></span>'
            +     '<span>AB: <span id="ab-status" style="color:#ff8800;">OFF</span></span>'
            +   '</div>'
@@ -526,9 +576,9 @@
        const burnRate = calculateBurnRate();
        const throttle = Math.abs(window.geofs.animation.values.smoothThrottle || 0);
        const engines  = window.geofs.aircraft.instance.engines;
        const acData   = getAircraftData();
        const abCapable = hasAfterburner(engines);
        const abActive  = abCapable ? isAbActive(engines, throttle) : false;

        const acNameEl = document.getElementById('fuel-ac-name');
        if (acNameEl) acNameEl.textContent = acData
@@ -556,121 +606,124 @@
            } else { endEl.textContent = '--'; }
        }

        // AB indicator only shown for aircraft that actually have an afterburner
        const abStatusEl = document.getElementById('ab-status');
        const abLabelSpan = abStatusEl ? abStatusEl.parentElement : null; // "AB: <span>"
        if (abLabelSpan) abLabelSpan.style.display = abCapable ? 'inline' : 'none';
        if (abStatusEl) { abStatusEl.textContent = abActive ? 'ON' : 'OFF'; abStatusEl.style.color = abActive ? '#ff4400' : '#ff8800'; }

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

        if (fuelState.lastAircraft !== id || !fuelState.initialized) {
            fuelState.maxFuel      = getFuelCapacity();
            if (!fuelState.initialized || fuelState.lastAircraft !== id) {
                fuelState.fuel = fuelState.maxFuel;
            }
            fuelState.lastAircraft = id;
            fuelState.initialized  = true;
            console.log('[Fuel v' + VERSION + '] ' + detectAircraftType() + ' | Capacity: ' + fuelState.maxFuel + ' kg');
        }

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

    console.log('[GeoFS Fuel System v' + VERSION + '] Fighters + Civilian | 5 Hz updates | Progressive refuel | H = toggle HUD');
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
