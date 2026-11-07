# Flow UI Restyling Implementation Notes & Design Mapping

## Design Tokens Extracted from `/design/*.html`

### 1. Color Palette (Light theme tokens & Dark theme pairings)
From the design reference files (`today_flow.html`, `inbox_flow.html`, etc.), the following color system was extracted:

- **Surface / Background:**
  - `surface` / `surface-canvas`: `#FAFAF7` (warm paper canvas background)
  - `surface-card` / `surface-container-lowest`: `#FFFFFF` (elevated cards, bottom sheets)
  - `surface-container-low`: `#F1F3FF`
  - `surface-container`: `#E9EDFF` (neutral chip background, quiet badges)
  - `surface-container-high`: `#E1E8FD`
  - `surface-container-highest` / `surface-variant`: `#DCE2F7`
  - `surface-dim`: `#D3DAEF`
  - `surface-bright`: `#F9F9FF`
  - `background`: `#F9F9FF`

- **Text / On-Surface:**
  - `on-surface` / `on-background`: `#141B2B` (deep charcoal-blue ink)
  - `on-surface-variant`: `#464555`
  - `text-muted`: `#71717A` (secondary descriptions, quiet labels)
  - `text-subtle`: `#A1A1AA` (subtle captions, borders/placeholders)

- **Primary / Accent:**
  - `primary`: `#3525CD`
  - `primary-container`: `#4F46E5` (the default Flow indigo accent, action buttons, progress rings, FAB)
  - `on-primary`: `#FFFFFF`
  - `on-primary-container`: `#DAD7FF`
  - `primary-fixed`: `#E2DFFF`
  - `primary-fixed-dim`: `#C3C0FF`

- **Secondary:**
  - `secondary`: `#58579B` (project/tag labels, secondary emphasis)
  - `secondary-container`: `#B6B4FF`
  - `on-secondary-container`: `#454386`

- **Semantic / Priorities:**
  - `error` / `P1`: `#BA1A1A`
  - `error-container`: `#FFDAD6` (P1 flag & overdue chip backgrounds)
  - `on-error-container`: `#93000a`
  - `tertiary` / `P2`: `#7E3000` (amber / warm brown)
  - `tertiary-fixed`: `#FFDBCC` (P2 badge background)
  - `on-tertiary-fixed`: `#351000`
  - `P3`: `#2563EB` / `#4F46E5`
  - `border-subtle`: `#EEEEEC`
  - `border-strong`: `#E5E5DF`
  - `outline`: `#777587`
  - `outline-variant`: `#C7C4D8`

- **Dark Theme Mapping:**
  - Canvas `--bg`: `#12141a`
  - Card `--surface` / `--bg-elevated`: `#1a1d26`
  - Containers `--surface-2`: `#242838`, `--surface-3`: `#2e3347`
  - Text `--text`: `#edf0ff`, `--text-2`: `#a5abbd`, `--text-3`: `#71788e`
  - Borders: `--border`: `#262a38`, `--border-strong`: `#353a4d`
  - Semantic: `--danger`: `#ff8585`, `--danger-soft`: `rgba(186, 26, 26, 0.25)`, `--success`: `#4ade80`

### 2. Typography Scale
- `headline-xl`: 34px / 40px, letter-spacing: -0.03em, font-weight: 700
- `headline-lg`: 26px / 32px, letter-spacing: -0.02em, font-weight: 600
- `headline-md`: 20px / 26px, letter-spacing: -0.015em, font-weight: 600
- `headline-sm`: 17px / 22px, letter-spacing: -0.01em, font-weight: 600
- `body-lg`: 16px / 24px, letter-spacing: -0.01em, font-weight: 400
- `body-md`: 15px / 22px, letter-spacing: 0, font-weight: 400
- `body-sm`: 13px / 18px, letter-spacing: 0, font-weight: 400
- `label-md`: 13px / 16px, letter-spacing: 0.01em, font-weight: 500
- `label-sm`: 11px / 14px, letter-spacing: 0.04em, font-weight: 600
- System font stack preserved as required.

### 3. Radii & Shadows
- **Radii:**
  - `--radius-xs`: 4px (`rounded`)
  - `--radius-s`: 8px (`rounded-lg`)
  - `--radius`: 12px (`rounded-xl` for cards, task rows)
  - `--radius-l`: 16px / 24px (`rounded-2xl` / `rounded-3xl` for sheets & modals)
  - `--radius-full`: 9999px (`rounded-full` for chips, pills, FAB, buttons)
- **Shadows:**
  - `--shadow-sm`: `0 1px 3px rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.03)`
  - `--shadow-1`: `0 1px 3px rgba(0,0,0,0.02), 0 4px 12px rgba(17,24,39,0.03)`
  - `--shadow-2`: `0 4px 14px rgba(79,70,229,0.25)` (accent action glow)
  - `--shadow-fab`: `0 12px 28px -4px rgba(79,70,229,0.35)`
  - `--shadow-sheet`: `0 -10px 35px rgba(0,0,0,0.12)`
  - `--shadow-modal`: `0 12px 40px rgba(17,24,39,0.14)`

---

## Screen & Component Mapping Table

| Screen / Feature | Design File | App Files to Change | Key Classes & DOM Elements |
| --- | --- | --- | --- |
| **Tokens & Base** | All designs | `css/base.css` | `:root`, `[data-theme="dark"]`, `--bg`, `--surface`, `--surface-card`, `--surface-container`, `--text`, `--border-*`, typography variables |
| **Shared Components** | All designs | `css/components.css`, `js/ui.js` | `.btn`, `.btn-primary`, `.btn-ghost`, `.chip`, `.chip-date`, `.chip-project`, `.task-row`, `.tr-inner`, `.tr-check`, `.pflag`, `.fab`, `.tabbar`, `.tab`, `.sheet`, `.modal`, `.toast`, `.switch`, `.seg` |
| **Today Screen** | `today_flow.html` | `css/views.css`, `js/views/today.js` | `.today-head`, `.today-metric-card`, `.ring-wrap`, `.today-banner`, `.today-list`, `.tl-wrap`, `.tl-scroll`, `.tl-track`, `.tl-block`, `.tl-now`, `.tl-hour-label` |
| **Quick Add Sheet** | `today_quick_add_sheet.html` | `css/views.css`, `js/main.js` | `.qa-sheet`, `.qa-preview`, `.qa-chips`, `.pchip`, `.qa-input`, `.qa-footer`, `.qa-hint` |
| **Inbox & Lists** | `inbox_flow.html` | `css/views.css`, `js/views/list.js` | `.view-head`, `.view-title`, `.tip-card`, `.task-list`, swipe indicators, empty states |
| **Upcoming** | `upcoming_flow.html` | `css/views.css`, `js/views/upcoming.js` | `.day-group`, `.day-head`, `.day-name`, `.day-tasks`, `.day-add`, horizon header, filter strip |
| **Task Detail** | `task_detail_bottom_sheet.html` | `css/views.css`, `js/views/detail.js` | `.detail-title`, `.detail-chips`, `.detail-card`, `.detail-section`, `.detail-actions`, subtasks list, markdown notes styling |
| **Browse** | `browse_flow.html` | `css/views.css`, `js/views/browse.js` | `.tool-grid`, `.tool-card`, `.mindful-banner`, `.nav-entry`, `.area-entry` |
| **Matrix** | `eisenhower_matrix_flow.html` | `css/views.css`, `js/views/matrix.js` | `.matrix`, `.matrix-cell`, `.matrix-head`, `.mcard`, quadrant headers, empty cues |
| **Habits** | `habits_flow.html` | `css/views.css`, `js/views/habits.js` | `.habit-card`, `.habit-check`, `.habit-streak`, `.habit-week`, `.habit-day`, `.heatmap`, `.heat-cell`, momentum card |
| **Focus** | `focus_flow.html` | `css/views.css`, `js/views/focus.js` | `.focus-ring-wrap`, `.focus-ring`, `.focus-time`, `.focus-mode`, `.ambient-card`, `.fab-static`, timer controls |
| **Settings** | N/A | `css/views.css`, `js/views/settings.js` | `.settings-section`, `.settings-row`, `.accent-swatch`, `.devpanel` |
| **Desktop Layout** | `today_desktop.html` | `css/views.css`, `js/main.js` | `@media (min-width: 900px)`, `.sidebar`, `.side-link`, `.side-group`, `.shell`, two-column layout |

## Deliberate Deviations / Preserved Constraints
1. **Fonts:** Kept system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`) to adhere to hard constraints (no external fonts / CDNs).
2. **Icons:** Preserved the built-in SVG icon system in `js/ui.js` rather than loading external Material Symbols webfont.
3. **Behavior & Data Logic:** Drag, resize, timeline snap (15 min), swipe actions, store subscriptions, and parser logic remain untouched.
