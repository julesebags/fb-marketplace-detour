// Drives Facebook's own "Change location" modal so the overridden GPS fix
// is committed to the Marketplace search.
//
// Selectors anchor only on role, aria-label and visible text. Facebook's
// generated class names (x1i10hfl and friends) are unstable and never used.
(function () {
  "use strict";

  const NS = (window.DetourRouter = window.DetourRouter || {});
  const LOG = "[DetourRouter]";


  const DIALOG_SELECTOR = '[role="dialog"][aria-label="Change location"]';
  const LOCATE_SELECTOR =
    '[role="button"][aria-label="Marketplace geolocation picker"]';
  const LOCATE_ICON_PREFIX = "M13.578 4.85c.446-1.488";

  // U+00B7 middle dot, e.g. "Hong Kong · 2 km".
  const SUMMARY_RE = /·\s*\d+(\.\d+)?\s*(km|mi)\b/i;

  const CENTER_RE = /center=(-?\d+(?:\.\d+)?)(?:%2C|%2c|,)(-?\d+(?:\.\d+)?)/;
  const CENTER_EPSILON = 0.0001;

  // --- helpers ------------------------------------------------------------

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .replace(/[\s ]+/g, " ")
      .trim();
  }

  // Facebook's buttons are React handlers on div[role="button"], which only
  // react to the full press sequence -- a bare .click() is not enough.
  function realClick(element) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // No `view`: passing it has been observed to break React's synthetic
    // event handling in extension contexts.
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
    };
    const pointer = { ...base, pointerId: 1, isPrimary: true, pointerType: "mouse" };

    element.dispatchEvent(
      new PointerEvent("pointerdown", { ...pointer, button: 0, buttons: 1 })
    );
    element.dispatchEvent(
      new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 })
    );
    element.dispatchEvent(
      new PointerEvent("pointerup", { ...pointer, button: 0, buttons: 0 })
    );
    element.dispatchEvent(
      new MouseEvent("mouseup", { ...base, button: 0, buttons: 0 })
    );
    element.dispatchEvent(new MouseEvent("click", { ...base, button: 0 }));
    return true;
  }

  // Resolves with the first truthy value fn() returns, or null on timeout.
  // Never throws, so a failing step reports rather than breaking the run.
  function waitFor(fn, options) {
    const { timeout = 3000, interval = 100, label = "condition" } =
      options || {};
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout;
      (function poll() {
        let value = null;
        try {
          value = fn();
        } catch (error) {
          value = null;
        }
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() >= deadline) {
          console.error(`${LOG} timed out waiting for: ${label}`);
          resolve(null);
          return;
        }
        setTimeout(poll, interval);
      })();
    });
  }

  function getModalMapCenter(dialog) {
    const scope = dialog || document;
    const node =
      scope.querySelector('[style*="static_map.php"]') ||
      scope.querySelector('[style*="static_map"]');
    if (!node) return null;

    // content.js already parses these URLs; reuse it when available.
    if (NS.staticMapUrlFrom && NS.parseStaticMapUrl) {
      try {
        const url = NS.staticMapUrlFrom(node);
        const parsed = url ? NS.parseStaticMapUrl(url) : null;
        if (parsed) return { lat: parsed.lat, lon: parsed.lon };
      } catch (error) {
        // fall through to the regex below
      }
    }

    const match = CENTER_RE.exec(node.getAttribute("style") || "");
    if (!match) return null;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }

  function centersDiffer(a, b) {
    if (!a || !b) return false;
    return (
      Math.abs(a.lat - b.lat) > CENTER_EPSILON ||
      Math.abs(a.lon - b.lon) > CENTER_EPSILON
    );
  }

  function comboValueText(combo) {
    return normalizeText(combo && combo.textContent);
  }

  // How close the modal's map centre must land to the spoofed coordinates
  // before we believe the override took. Facebook snaps to a nearby place,
  // so this is deliberately loose.
  const TARGET_TOLERANCE_DEG = 0.01;

  function withinTolerance(center, target) {
    if (!center || !target) return false;
    return (
      Math.abs(center.lat - target.lat) <= TARGET_TOLERANCE_DEG &&
      Math.abs(center.lon - target.lon) <= TARGET_TOLERANCE_DEG
    );
  }

  function formatCenter(center) {
    return center ? `${center.lat},${center.lon}` : "nothing";
  }

  function closeDialog(dialog) {
    const close = dialog.querySelector('[role="button"][aria-label="Close"]');
    if (close) {
      realClick(close);
      return true;
    }
    console.warn(`${LOG} could not find the dialog's Close button`);
    return false;
  }

  // --- the sequence -------------------------------------------------------

  async function applyOverriddenLocation(options) {
    const opts = options || {};
    const radiusKm = opts.radiusKm;
    const target =
      Number.isFinite(opts.lat) && Number.isFinite(opts.lon)
        ? { lat: opts.lat, lon: opts.lon }
        : null;

    // Step 0 ----------------------------------------------------------------
    const before5 = NS.snapshotListingIds ? NS.snapshotListingIds(5) : [];
    console.log(`${LOG} step 0: listing snapshot`, before5);

    // Step A ----------------------------------------------------------------
    let dialog = document.querySelector(DIALOG_SELECTOR);
    if (dialog) {
      console.log(`${LOG} step A: dialog already open, skipping`);
    } else {
      const buttons = Array.from(
        document.querySelectorAll('[role="button"]')
      ).filter((button) => SUMMARY_RE.test(normalizeText(button.textContent)));

      if (!buttons.length) {
        console.error(`${LOG} step A: location summary button not found`);
        return { ok: false, error: "step A: location summary button not found" };
      }

      // Shortest text == innermost button, not a container wrapping it.
      buttons.sort(
        (a, b) =>
          normalizeText(a.textContent).length -
          normalizeText(b.textContent).length
      );
      const target = buttons[0];
      console.log(
        `${LOG} step A: clicking "${normalizeText(target.textContent)}" (${buttons.length} candidate(s))`
      );
      realClick(target);
    }

    // Step B ----------------------------------------------------------------
    dialog =
      dialog ||
      (await waitFor(() => document.querySelector(DIALOG_SELECTOR), {
        label: "change-location dialog",
      }));
    if (!dialog) {
      return { ok: false, error: "step B: change-location dialog never opened" };
    }
    console.log(`${LOG} step B: dialog open`);

    // Step C ----------------------------------------------------------------
    const before = getModalMapCenter(dialog);
    console.log(`${LOG} step C: map center before`, before, "target", target);

    // Step D ----------------------------------------------------------------
    // The map centre is the only evidence the spoof actually took. If it
    // never reaches the target we must NOT apply: doing so would quietly
    // return listings from the wrong place.
    if (target && withinTolerance(before, target)) {
      console.log(
        `${LOG} step D: map center already at target, skipping locate-me`
      );
    } else {
      let locate = dialog.querySelector(LOCATE_SELECTOR);
      if (!locate) {
        const path = Array.from(dialog.querySelectorAll("svg path")).find((p) =>
          (p.getAttribute("d") || "").startsWith(LOCATE_ICON_PREFIX)
        );
        // Never click the SVG itself; React listens on the role="button".
        locate = path ? path.closest('[role="button"]') : null;
      }
      if (!locate) {
        console.error(`${LOG} step D: locate-me button not found`);
        return { ok: false, error: "step D: locate-me button not found" };
      }
      console.log(`${LOG} step D: clicking locate-me`);
      realClick(locate);

      let lastSeen = before;
      const reached = await waitFor(
        () => {
          const now = getModalMapCenter(dialog);
          if (now) lastSeen = now;
          if (target) return withinTolerance(now, target) ? now : null;
          // No target supplied: fall back to "it moved at all".
          return now && centersDiffer(now, before) ? now : null;
        },
        {
          timeout: 5000,
          label: target
            ? "map center to reach the target coordinates"
            : "map center to update after locate-me",
        }
      );

      if (!reached) {
        console.error(
          `${LOG} step D: map center never reached target.`,
          "before:",
          before,
          "last seen:",
          lastSeen,
          "target:",
          target
        );
        closeDialog(dialog);
        return {
          ok: false,
          error:
            `step D: map center never reached target ` +
            `(saw ${formatCenter(lastSeen)}, wanted ${formatCenter(target)})`,
        };
      }
      console.log(`${LOG} step D: map center after`, reached);
    }

    // Step E ----------------------------------------------------------------
    if (radiusKm) {
      await setRadius(dialog, radiusKm);
    }

    // Step F ----------------------------------------------------------------
    const apply = dialog.querySelector('[role="button"][aria-label="Apply"]');
    if (!apply) {
      console.error(`${LOG} step F: Apply button not found`);
      return { ok: false, error: "step F: Apply button not found" };
    }
    console.log(`${LOG} step F: clicking Apply`);
    realClick(apply);

    // Step G ----------------------------------------------------------------
    const closed = await waitFor(
      () => (!document.contains(dialog) ? true : null),
      { label: "dialog to close" }
    );
    console.log(`${LOG} step G: dialog closed = ${!!closed}`);

    // Step H ----------------------------------------------------------------
    const changed = await waitFor(
      () => {
        const now = NS.snapshotListingIds ? NS.snapshotListingIds(5) : [];
        return now.length && now.join(",") !== before5.join(",") ? now : null;
      },
      { timeout: 5000, label: "feed listings to change" }
    );
    if (changed) {
      console.log(`${LOG} step H: feed changed`, changed);
    } else {
      console.warn(
        `${LOG} step H: feed ids unchanged — the new location may return the same listings; continuing`
      );
    }

    return { ok: true, error: null };
  }

  async function setRadius(dialog, radiusKm) {
    const combos = Array.from(
      dialog.querySelectorAll('label[role="combobox"][aria-haspopup="listbox"]')
    );

    const combo = combos.find((candidate) => {
      const ids = (candidate.getAttribute("aria-labelledby") || "").split(/\s+/);
      return ids.some((id) => {
        const labelled = id && document.getElementById(id);
        return labelled && /radius/i.test(normalizeText(labelled.textContent));
      });
    });

    if (!combo) {
      console.error(
        `${LOG} step E: radius combobox not found (${combos.length} combobox(es) in dialog)`
      );
      return;
    }

    const current = comboValueText(combo);
    console.log(`${LOG} step E: radius currently "${current}"`);
    if (current.startsWith(`${radiusKm} `)) {
      console.log(`${LOG} step E: already ${radiusKm}, skipping`);
      return;
    }

    realClick(combo);

    const options = await waitFor(
      () => {
        // The listbox is probably portalled outside the dialog.
        const found = document.querySelectorAll('[role="option"]');
        return found.length ? Array.from(found) : null;
      },
      { label: "radius options" }
    );
    if (!options) return;

    const labels = options.map((option) => normalizeText(option.textContent));
    console.log(`${LOG} step E: radius options`, labels);

    const wanted = new RegExp(`^${radiusKm}\\s`);
    const index = labels.findIndex((label) => wanted.test(label));

    if (index === -1) {
      console.error(
        `${LOG} step E: no option matching "${radiusKm}" — available:`,
        labels
      );
      combo.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
      return;
    }

    console.log(`${LOG} step E: choosing "${labels[index]}"`);
    realClick(options[index]);
    await waitFor(
      () => (comboValueText(combo).startsWith(`${radiusKm} `) ? true : null),
      { label: `radius combobox to read ${radiusKm}` }
    );
  }

  NS.applyOverriddenLocation = applyOverriddenLocation;
  NS.realClick = realClick;
  NS.waitFor = waitFor;
  NS.normalizeText = normalizeText;
  NS.getModalMapCenter = getModalMapCenter;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      applyOverriddenLocation,
      realClick,
      waitFor,
      normalizeText,
      getModalMapCenter,
      centersDiffer,
      SUMMARY_RE,
    };
  }
})();
