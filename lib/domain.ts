/**
 * domain.ts — Canonical domain types (AR3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this file there were THREE incompatible entity shapes for the same two
 * concepts, none of them tenant-aware:
 *
 *   Chart:
 *     - lib/store.ts `SavedChart`      → { id, title, description?, config, data[], createdAt, queryName? }
 *                                        (a rendered chart: Recharts config + the actual result rows)
 *     - lib/chartStore.ts `SavedChart` → { id, title, type, dataset, metrics[], dimensions[],
 *                                          createdAt, modifiedAt }
 *                                        (a chart *definition*: type + dataset + metric/dimension picks)
 *
 *   Dashboard:
 *     - lib/store.ts `Dashboard`          → { id, name, status, charts[], createdAt, updatedAt, owner }
 *                                           (legacy: embeds fully-rendered SavedCharts)
 *     - lib/dashboardStore.ts `CanvasDashboard` → { id, name, status, widgets[], filters[],
 *                                                   createdAt, updatedAt }  ← NO owner, NO org
 *                                           (canvas: references charts by id via widgets + has filters)
 *
 * RECONCILIATION
 * --------------
 * ONE canonical `Chart` carries the UNION of both variants' fields, so nothing is
 * lost. Config+data (render form) and type/dataset/metrics/dimensions (definition
 * form) coexist; a given chart may populate either or both.
 *
 * ONE canonical `Dashboard` holds BOTH the legacy embedded `charts[]` AND the
 * canvas `widgets[]`/`filters[]`, so a dashboard created by either UI round-trips
 * losslessly.
 *
 * TENANCY (AR1/AR2/B2): EVERY entity now carries the tenant/ownership tuple:
 *   id, orgId, owner (= a userId), createdAt, updatedAt.
 * These are stamped by the repository from the session — never trusted from the
 * client (see lib/repository.ts).
 *
 * OLD-SHAPE FIELD MAP (old → canonical):
 *   store.SavedChart.title/description/config/data/createdAt/queryName → same names on Chart
 *   chartStore.SavedChart.type/dataset/metrics/dimensions              → same names on Chart
 *   chartStore.SavedChart.modifiedAt                                   → Chart.updatedAt
 *   store.Dashboard.charts/name/status/owner/createdAt/updatedAt       → same names on Dashboard
 *   CanvasDashboard.widgets/filters                                    → same names on Dashboard
 *   (CanvasDashboard had no owner/orgId — now required, stamped server-side)
 */

import type { ChartConfig } from '@/components/DataExplorer/ChartPreview'

// ── Shared tenancy/ownership envelope ───────────────────────────────────────────

/**
 * Fields every persisted entity carries. Stamped by the repository from the
 * session; the client MUST NOT be trusted to supply orgId/owner.
 */
export type OwnedEntity = {
  id: string
  /** Tenant key. Set to session.orgId by the repository on write. */
  orgId: string
  /** Owning userId. Set to session.userId by the repository on write. */
  owner: string
  createdAt: string
  updatedAt: string
}

// ── Chart-definition sub-shapes (union of both legacy variants) ──────────────────

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'bigNumber' | 'table'

// ── Canonical Chart ──────────────────────────────────────────────────────────────

/**
 * Canonical chart. Carries BOTH the "rendered" form (config + data rows, from
 * lib/store.ts) and the "definition" form (type/dataset/metrics/dimensions, from
 * lib/chartStore.ts). Either or both may be present.
 */
export type Chart = OwnedEntity & {
  title: string
  description?: string

  // — rendered form (store.SavedChart) —
  config?: ChartConfig
  data?: Record<string, unknown>[]
  queryName?: string

  // — definition form (chartStore.SavedChart) —
  type?: ChartKind
  dataset?: string
  metrics?: string[]
  dimensions?: string[]
}

// ── Canvas sub-shapes (from lib/dashboardStore.ts) ──────────────────────────────

export type WidgetSize = 'small' | 'medium' | 'large'

export type CanvasWidget = {
  id: string
  chartId: string
  chartName: string
  chartType: string
  size: WidgetSize
  order: number
}

export type DashboardFilter = {
  id: string
  column: string
  value?: string
}

export type DashboardStatus = 'Draft' | 'Published'

// ── Canonical Dashboard ──────────────────────────────────────────────────────────

/**
 * Canonical dashboard. Holds BOTH the legacy embedded charts[] (store.Dashboard)
 * and the canvas widgets[]/filters[] (CanvasDashboard). A dashboard authored by
 * either UI is representable without loss.
 */
export type Dashboard = OwnedEntity & {
  name: string
  status: DashboardStatus

  // — legacy embedded charts (store.Dashboard) —
  charts: Chart[]

  // — canvas form (CanvasDashboard) —
  widgets: CanvasWidget[]
  filters: DashboardFilter[]
}

// ── Client-side draft inputs ─────────────────────────────────────────────────────
//
// The client constructs entities WITHOUT the server-stamped tenancy fields; the
// repository fills orgId/owner/createdAt/updatedAt. These input aliases make the
// server-stamped fields optional so client code that builds a partial object still
// typechecks, while the persisted canonical type keeps them required.

/** A chart as submitted by the client (server stamps orgId/owner/updatedAt). */
export type ChartInput = Omit<Chart, keyof OwnedEntity> & {
  id: string
  createdAt?: string
  orgId?: string
  owner?: string
  updatedAt?: string
}

/** A dashboard as submitted by the client (server stamps orgId/owner/updatedAt). */
export type DashboardInput = Omit<Dashboard, keyof OwnedEntity | 'charts' | 'widgets' | 'filters'> & {
  id: string
  createdAt?: string
  orgId?: string
  owner?: string
  updatedAt?: string
  charts?: Chart[]
  widgets?: CanvasWidget[]
  filters?: DashboardFilter[]
}
