// Weekly reset cycle validation.
//
// The weekly quota runs on a fixed 7-day cadence, so a freshly parsed weekly reset can
// only be the one already known, or a new one read after the previous cycle expired.
// Anything else is a misparse — a saturated PTY drops a digit or misaligns the /usage
// section, producing a reset date shifted by a day.
//
// That matters beyond the reset display: `weekId` is derived from the reset, and
// `filterAnomalies` treats a weekId change as "new cycle, accept anything". A day-shifted
// misparse is therefore the door a false mid-cycle drop walks through. See issue #37.

const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TOLERANCE_MS = 2 * 60 * 60 * 1000; // absorbs rounding, never a day shift

/**
 * Is `candidateISO` a credible weekly reset, given the cycle anchor we already hold?
 *
 * @param {string|null} candidateISO  freshly parsed reset timestamp
 * @param {string|null} anchorISO     last reset we accepted, or null when unset
 * @param {number} [now]              current epoch ms (injectable for tests)
 */
function isPlausibleWeeklyReset(candidateISO, anchorISO, now = Date.now()) {
  const cand = new Date(candidateISO).getTime();
  if (Number.isNaN(cand)) return false;

  // A weekly reset is always ahead of us and never more than one cycle out.
  if (cand <= now || cand > now + CYCLE_MS + RESET_TOLERANCE_MS) return false;

  const anchor = new Date(anchorISO).getTime();
  // No anchor yet, or the anchor already expired => this read re-anchors the cycle.
  // A rollover only ever arrives through here: /usage reports the next reset once the
  // previous one has passed, never while it is still ahead of us.
  if (!anchorISO || Number.isNaN(anchor) || anchor <= now) return true;

  // Anchor still valid => the reset cannot have moved. Only the same instant is credible.
  return Math.abs(cand - anchor) <= RESET_TOLERANCE_MS;
}

module.exports = { isPlausibleWeeklyReset, CYCLE_MS, RESET_TOLERANCE_MS };
