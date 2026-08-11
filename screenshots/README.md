# Screenshots

All three are **synthetic demo data**, not anyone's real usage. Every one carries the orange
`DEMO MODE — SYNTHETIC DATA. NOT REAL USAGE.` banner, which is pinned to the top of the viewport
so it stays in frame no matter where the page is scrolled.

| File | Shows | Size |
|---|---|---|
| `dashboard-overview.png` | Overview: official `/usage` gauges, cumulative curve, burn rate, daily/hourly consumption, activity heatmap | 1280×2024 |
| `weekly-tab.png` | Weekly: cycle progress, one cumulative curve per cycle, weekly history including cycles that hit 100% | 1280×1300 |
| `what-burned-it.png` | The local fuel **proxy** — shares by project and the heaviest sessions | 1280×840 |

## Re-capturing them

Never shoot these from a real instance: the gauges are your actual quota and the panel labels are
your actual project directory names.

```bash
npm run demo        # http://localhost:3401 — synthetic fixture, both collectors off
```

Then, in a browser:

1. **Size the viewport to the content and capture the viewport.** Do *not* use a full-page
   screenshot: that resizes the viewport at capture time, Chart.js re-renders, and the capture
   catches a chart mid-redraw — you get an empty plot area with the axes drawn. Measured; it is
   not a timing problem you can wait out.
2. Give the charts a couple of seconds to finish animating before capturing.
3. For `what-burned-it.png`, scroll the panel under the pinned banner and header so the synthetic
   data marker stays visible.
4. Save as PNG with a 256-colour adaptive palette. This UI is flat fills plus antialiased text, so
   the palette is visually lossless here and roughly a third of the weight — verified by reading
   the smallest text and the chart curves at 1:1 afterwards.

Captured at 1× (CSS pixels), so the text is crisp at native size.
