// ==============================================================
// GeoFS Aircraft Realistic Fuel System (Fighters + Civilian)
// Version: 4.4.1 (Concorde AB fuel fix)
// ==============================================================

(function () {
    'use strict';

    const VERSION           = '4.4.1';
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
        't-38':        { capacity:  1540, engines: 2, name: 'T-38 Talon',            hasAb: false, burnProfile: null, unverified: true }
    };

    // ── Civilian fuel database ──────────────────────────────────
    // burnProfile.idleKgHr / cruiseKgHr / maxKgHr are TOTAL across all engines,
    // sourced from manufacturer data / published performance figures where available.
    const CIVILIAN_FUEL_DB = {
        'a380':        { capacity: 253983, engines: 4, name: 'Airbus A380',
                          hasAb: false, burnProfile: { idleKgHr: 3600,  cruiseKgHr: 12000, maxKgHr: 16000 } }, // corrected 253000 -> 253983
        '737-700':     { capacity:  20800, engines: 2, name: 'Boeing 737-700',
                          hasAb: false, burnProfile: { idleKgHr: 700,   cruiseKgHr: 2400,  maxKgHr: 4200 } },

        // Concorde: capacity as before (95,680 kg). Supersonic cruise is ~20,500 kg/h total,
        // and full reheat (afterburner) at takeoff is ~82,800 kg/h total (≈20,700 kg/h per engine).
        // The older 26,000 kg/h value was likely a mistaken conversion from ~26,000 L/h.
        // Sources: manufacturer/performance summaries and historical operator data. [web:2][web:3][web:5]
        'concorde':    { capacity:  95680, engines: 4, name: 'Concorde',
                          hasAb: false, burnProfile: { idleKgHr: 4000,  cruiseKgHr: 20500, maxKgHr: 82800 } },

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
    const AIRCRAFT_FUEL_DB = Object.assign({}, FIGHTER_FUEL_DB, CIVILIAN_FUEL_DB);

    // ── State ─────────────────────────────────────────────────
    let fuelState = {
        fuel:             0,
        maxFuel:          0,
        initialized:      false,
        lastAircraft:     null,
        refuelling:       false,
        refuelStartFuel:  0,
        refuelStartTime:  null,
        refuelDuration:   REFUEL_DURATION_S
    };

    let hudVisible  = true;
    let isDragging  = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let hudLeft     = null, hudTop = null;

    const settings = {
        dynamicBingoEnabled: false,
        autoNearestBase:     true,
        reserveMinutes:      10,
        cruiseSpeedKmh:      900,
        refuelDuration:      REFUEL_DURATION_S,
        bases:               [],
        selectedBaseIndex:   0
    };

    // ──────────────────────────────────────────────────────────
    // AIRCRAFT DETECTION (fighters + civilian)
    // ──────────────────────────────────────────────────────────
    function detectAircraftType() {
        const name = (window.geofs.aircraft.instance.aircraftRecord.name || '').toLowerCase();
        for (const key of Object.keys(AIRCRAFT_FUEL_DB)) {
            if (name.includes(key)) return key;
        }
        return null;
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

    // ──────────────────────────────────────────────────────────
    // AFTERBURNER DETECTION
    // ──────────────────────────────────────────────────────────
    function getAbThrust(engine) {
        return engine.afterBurnerThrust || engine.afterburnerThrust || 0;
    }

    function hasAfterburner(engines) {
        const data = getAircraftData();
        if (data) return !!data.hasAb;
        if (!engines || !engines.length) return false;
        const e = engines[0];
        return (e.afterBurnerThrust != null && e.afterBurnerThrust > 0) ||
               (e.afterburnerThrust != null && e.afterburnerThrust > 0);
    }

    function isAbActive(engines, throttle) {
        if (!hasAfterburner(engines)) return false;
        if (!engines || !engines.length) return false;
        const e = engines[0];

        if (e.afterburnerLit != null)   return !!e.afterburnerLit;
        if (e.afterburnerOn  != null)   return !!e.afterburnerOn;
        if (e.abLit          != null)   return !!e.abLit;
        if (e.abOn           != null)   return !!e.abOn;
        if (typeof e.afterburner === 'boolean') return e.afterburner;

        const dry   = e.thrust || 0;
        const live  = e.currentThrust || e.outputThrust || 0;
        if (dry > 0 && live > dry * 1.20) {
            return true;
        }

        return throttle > 0.92;
    }

    // ──────────────────────────────────────────────────────────
    // BURN RATE  (kg / hr)
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
        const abActive        = isAbActive(engines, throttle);

        const idleFractionOfMil = 0.08;
        const abFactorOverMil   = 1.6;

        const fullMilBurnRate = totalDryThrust / 22;
        const idleBurnRate    = fullMilBurnRate * idleFractionOfMil;

        if (abActive && totalAbThrust > 0) {
            const abBurnRate = fullMilBurnRate * abFactorOverMil;
            const abBlend = Math.max(0, throttle - 0.85) / 0.15;
            return idleBurnRate +
                   (fullMilBurnRate - idleBurnRate) * throttle +
                   (abBurnRate - fullMilBurnRate) * abBlend;
        }

        return idleBurnRate + throttle * (fullMilBurnRate - idleBurnRate);
    }

    function getPlanningBurnRate() {
        const data = getAircraftData();
        if (data && data.burnProfile) return data.burnProfile.cruiseKgHr;

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
        fuelState.refuelDuration  = settings.refuelDuration;
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
        panel.style
