# Balun reference and compact Overview

The operator requested this appearance on 2026-11-12 (warren-f106).
The reference is [balun.courses](https://balun.courses/), inspected in a
browser and against its published CSS. `src/ui/src/tokens.css` owns the
runtime palette; the Direction C exports in this directory are historical.

## Appearance

| Use | Reference value |
| --- | --- |
| Background | `#070709` |
| Panel / raised surface | `#1e1e20` / `#28282a` |
| Main / secondary text | `#ffffff` / `#cdcaca` |
| Muted text | `#acacac` |
| Action | `#2af16b` with `#070709` ink |
| Warning / danger | `#f1a12a` / `#ff4a4a` |
| Corners | Square |

The dark theme carries these exact values. The existing light theme remains
available with contrasting semantic text on white. Alerts and toasts use
normal text on tinted surfaces: the ink intended for solid status fills
must never be used on a translucent warning background.

The reference's CSS family alias is misleading: its regular face is
**Roboto Mono Regular**, medium face is **Roboto Mono Bold**, and bold
headings use **Neue Machina Bold**. Font metadata and browser-computed
styles were inspected. All three files include Cyrillic and are served
locally from `src/ui/public/fonts/`:

- [Roboto Mono Regular](https://static.tildacdn.com/tild3235-3637-4362-b565-313930353163/RobotoMono-Regular.woff2)
- [Roboto Mono Bold](https://static.tildacdn.com/tild6461-3938-4036-a235-353234383463/RobotoMono-Bold.woff2)
- [Neue Machina Bold](https://static.tildacdn.com/tild3664-3265-4364-b436-663764326563/NeueMachina-Bold.woff2)

Roboto Mono's embedded metadata identifies Apache 2.0; its notice is included
as `ROBOTO-MONO-LICENSE.txt`. Neue Machina is a separate font; that notice
does not apply to it. These assets reproduce the operator's requested reference.

Use `text-sm` for body text and controls, `text-xs` as the minimum for metadata,
and 20–24px headings. Lucide icons use a consistent 1.75 stroke, at least
12px visible dimensions and 3:1 contrast. Text contrast is at least 4.5:1.

## Overview density

At desktop widths the three sections share a row: attention, current work,
Production. The overview shows two requests, up to three projects, and three
recent results. Each section links to its complete inventory. Current work
shows up to three tasks for one project, or one task per project when several
projects are selected. Project links retain the complete task count.

Compact Production cards show current release, readiness and the real Deploy
action. The confirmation and full Production page show the candidate commit,
release contents and history. A task still opens in its side panel.

The density contract is tested at 1440×900 and 1366×768, including three
projects with configured deployments. Phones keep a readable vertical flow.
Errors remain visible even when their explanation needs additional space.

## Rendered verification

`scripts/ui-visual/repros/warren-f106.pw.ts` reproduces the original overflow
and unreadable warning. `appearance.pw.ts` audits text size, actual font loading,
icon dimensions and icon contrast across every page in `pages.ts`, both
themes and both viewports. The existing smoke, axe, interaction and state
tests run alongside it. No laptop golden images are committed.
