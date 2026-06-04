# Recreating AMS.rent — Reference Architecture & Phased Build Plan

> Scope: a concrete engineering plan to build a product at parity with **AMS.rent**
> (a cloud rental-ERP for construction/logistics equipment, with native GPS/IoT
> telematics, pay-per-use billing, and Exact/SAP accounting integration).
>
> This is a planning document, not a commitment. Effort figures are order-of-magnitude
> estimates for a competent team; treat ranges, not point values, as the truth.

---

## 1. System context (the big picture)

AMS.rent is really **four products fused together**:

1. A **Rental ERP** — catalog → reservation → contract → invoice, multi-branch, accounting-grade.
2. A **Telematics/IoT platform** — ingests GPS + usage from hardware on machines, at fleet scale.
3. A **Pay-per-use billing engine** — turns metered usage into rated, invoiceable events.
4. An **Integration layer** — bidirectional, real-time sync with Exact / SAP and a public API.

```
                         ┌─────────────────────────────────────────────┐
        Browser  ─────▶  │              Web App (back-office)           │
        Customer ─────▶  │              Customer Portal                │
        iOS/Android ──▶  │              Mobile BFF / API Gateway       │
                         └───────────────┬─────────────────────────────┘
                                         │  (REST/GraphQL + WebSocket)
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                 │
 ┌──────▼───────┐  ┌──────────▼────────┐  ┌──────▼────────┐  ┌────────────▼────────┐
 │ Rental Core  │  │ Scheduling/Avail. │  │ Billing &     │  │ Telematics /        │
 │ (catalog,    │  │ (planning board,  │  │ Invoicing     │  │ IoT Ingestion       │
 │ contracts,   │  │ conflicts, logist.)│  │ (incl. pay-   │  │ (devices, GPS,      │
 │ customers)   │  │                   │  │ per-use)      │  │ usage, alerts)      │
 └──────┬───────┘  └──────────┬────────┘  └──────┬────────┘  └──────────┬──────────┘
        │                     │                  │                      │
        └──────────┬──────────┴───────┬──────────┴──────────┬───────────┘
                   │                  │                     │
            ┌──────▼──────┐    ┌──────▼──────┐       ┌──────▼────────────┐
            │ Postgres    │    │ Event bus    │       │ Time-series store │
            │ (OLTP, ERP) │    │ (Kafka/NATS) │       │ (Timescale/Influx)│
            └─────────────┘    └──────────────┘       └───────────────────┘
                   │
            ┌──────▼─────────────────────────────────────────────┐
            │ Integration layer → Exact, SAP, payment gateway,   │
            │ e-signature, mapping/geocoding, public API/webhooks│
            └────────────────────────────────────────────────────┘
```

**Architectural stance:** start as a **modular monolith** (one deployable, clean module
boundaries) and peel off only the genuinely independent subsystems — **telematics ingestion**
and **integration connectors** — into separate services. Resist premature microservices;
the ERP modules share too many transactions to split early without pain.

---

## 2. Recommended tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Language (core) | **TypeScript (Node)** or **Java/Kotlin (Spring)** or **C#/.NET** | Pick by team skill. .NET/JVM are common in ERP/finance for strong typing + decimal money handling. |
| API | REST (OpenAPI) + selective GraphQL for the portal | OpenAPI gives you typed clients + a public API for free. |
| Primary DB | **PostgreSQL** | ACID, strong constraints, `numeric` money, row-level security for multi-tenant/branch. |
| Time-series (telematics) | **TimescaleDB** or **InfluxDB** | GPS/usage is high-volume append-only time-series; don't put it in OLTP Postgres. |
| Event bus | **Kafka** (or NATS/RabbitMQ for smaller scale) | Decouples ingestion, billing-metering, and alerts. |
| Cache / realtime | Redis + WebSockets | Planning-board live updates, presence, locks. |
| Frontend (web) | **React + TypeScript** | Matches the existing repo (Vite/React/Tailwind/TanStack Query). |
| Mobile | **React Native** (shared) or native Swift/Kotlin | RN halves cost if the team is JS-strong; native if offline/maps are demanding. |
| Money | Decimal types only (`numeric`, `BigDecimal`, `decimal`) | **Never floats for money.** |
| Auth | OIDC (Keycloak/Auth0) | Multi-branch RBAC, customer portal, API tokens. |
| IaC / deploy | Docker + Kubernetes (or ECS) + Terraform | Telematics scale needs horizontal scaling. |
| Observability | OpenTelemetry + Grafana/Prometheus + Sentry | Financial + IoT systems need audit + tracing. |

---

## 3. Core domain model (the spine)

The data model is the highest-leverage design decision. Get these aggregates right early —
especially **money, multi-branch, and the contract state machine** — because retrofitting
them is the most expensive mistake.

```
Organization 1───* Branch 1───* User
Branch 1───* Asset (machine/tool)
Asset 1───* AssetLog (maintenance, certification, inspection)
Asset 0..1── Device (telematics unit)   Device 1───* UsageReading (time-series)

Customer 1───* ContactPerson
Customer 1───* Reservation ──▶ Contract ──▶ Invoice
Reservation *───* Asset (via ReservationLine, with period + price scale)
Contract 1───* ContractLine 1───* RatingEvent (incl. pay-per-use)
Contract 1───* DeliveryOrder / CollectionOrder (logistics)
Invoice 1───* InvoiceLine   Invoice 1───* Payment
PriceScale, TaxRule, Surcharge, CreditNote
```

**Non-negotiable design rules**
- **Multi-branch / multi-tenant from day 1.** Every row carries `organization_id` (+ `branch_id`).
  Enforce with Postgres Row-Level Security. Retrofitting tenancy later touches every table.
- **Contract as an explicit state machine:** `quote → reservation → active → closed → invoiced`,
  with a transition log (who/when/why). This is the audit backbone.
- **Money is immutable + auditable:** invoices, once issued, are never edited — only credited.
  Store currency, tax, and line-level detail. Append-only ledger thinking.
- **Time periods everywhere:** rentals are interval-based; model `[start, end)` ranges and use
  Postgres `tstzrange` + exclusion constraints to prevent overlapping bookings at the DB level.

---

## 4. The hard subsystems (where 70–80% of the cost lives)

### 4.1 Availability & planning board 🔴
- Conflict detection must be **transactional and concurrent-safe** — two users must not double-book
  the same asset. Use DB-level `EXCLUDE` constraints on `tstzrange` as the source of truth, not
  app-level checks.
- The interactive board = drag/resize bookings, multi-asset rows, delivery/collection logistics,
  live updates via WebSocket. Treat the UI as a serious front-end project, not a calendar widget.
- Logistics: delivery & collection orders tied to drivers/routes — optional route optimization later.

### 4.2 Billing & invoicing 🔴
- Partial invoices, periodic billing by date, pro-rata, surcharges (fuel, transport, insurance),
  line-level credits, multi-currency, tax rules per jurisdiction.
- Build a **rating engine**: `usage/period + price scale + surcharges + tax → invoice lines`.
- Idempotency + an audit ledger are mandatory. This is the module where bugs cost customers money,
  so it needs the highest test coverage (property-based + golden-file tests on real scenarios).

### 4.3 Telematics / IoT ingestion ⚫ (the moat)
- Devices on machines emit GPS + usage (engine hours, fuel, unauthorized-use). At fleet scale this is
  high-volume, append-only, out-of-order, intermittently-connected data.
- Pipeline: **device → gateway/MQTT → ingestion service → event bus → time-series store + alert engine**.
- Concerns: device provisioning & identity, firmware/protocol variance, dedup & late-arrival handling,
  back-pressure, geofencing, unauthorized-use alerts.
- **Build-vs-buy:** unless telematics is your strategic differentiator, **integrate an existing
  provider** (e.g., a telematics/MQTT platform) rather than building device firmware + ingestion from
  scratch. AMS had a multi-year head start here as their original core business.

### 4.4 Pay-per-use billing ⚫
- Couples 4.2 and 4.3: metered physical usage → rated billing events → invoice lines.
- Hard parts: defining billable usage from noisy sensor data, handling gaps/disputes, reconciliation,
  and making the result legally defensible on an invoice. Very few teams do this well — budget for it.

### 4.5 Exact / SAP + accounting integration ⚫
- Bidirectional, real-time-ish sync of customers, invoices, payments, ledgers against enterprise
  systems with their own quirks, auth, rate limits, and failure modes.
- Build a dedicated **connector service** with: a canonical internal model, per-system adapters,
  an outbox pattern for reliable delivery, reconciliation jobs, and a dead-letter/retry queue.
- Treat each ERP connector as its own workstream with a specialist; do **not** size it as a sprint.

---

## 5. Phased roadmap (milestone by milestone)

Effort is in **engineer-months (EM)**; assume a senior-ish team. Ranges reflect uncertainty.

### Phase 0 — Foundations (≈1–2 EM)
Repo/monorepo setup, CI/CD, auth/OIDC skeleton, multi-tenant Postgres with RLS, base entities,
observability baseline. *Exit:* a deployable shell with login, org/branch/user, and a health dashboard.

### Phase 1 — Rental core MVP (≈6–10 EM) 🟢🟡
- Asset catalog + customers (CRUD, search, per-asset logbook).
- Reservation → contract state machine, price scales, e-signature stub.
- Basic invoicing (full + simple partial), PDF generation.
- A first planning board (read + simple create), DB-level overlap prevention.
- *Exit:* a single branch can run a real rental cycle end to end.

### Phase 2 — Competitive product (≈18–30 EM) 🟡🔴
- Full interactive planning board + delivery/collection logistics.
- Customer portal (24/7 self-service: contracts, invoices, history).
- Online booking storefront synced live to availability.
- Maintenance/inspection/certificate scheduling + alerts.
- Reporting (revenue per branch **and** per machine; fuel/transport/insurance attribution).
- Multi-branch operations + consolidated reporting.
- One mobile app (iOS or Android) with damage photo capture + e-signature.
- Public API v1 (OpenAPI) + webhooks.
- *Exit:* credible competitor to Booqable/EZRentOut/Rentman for EU equipment rental.

### Phase 3 — The moats / full parity (≈40–80+ EM) 🔴⚫
- Telematics ingestion (buy-and-integrate strongly recommended) + device management + geofencing/alerts.
- Pay-per-use billing engine wired into invoicing.
- Exact + SAP connectors (dedicated workstream each).
- Second mobile app + offline support + navigation-to-machine.
- Full document management / e-signature, hardening to accounting-grade, security & pen-testing.
- *Exit:* feature parity with AMS.rent.

**Totals (rough):** MVP ≈ 6–10 EM · Competitive ≈ 30–50 EM cumulative · Full parity ≈ **120–200+ EM
(10–17 person-years)**, i.e. an **8–12 person org over ~2–3 years**.

---

## 6. Team shape for full parity

| Squad | People | Owns |
|---|---|---|
| Rental Core / ERP | 3–4 | Catalog, contracts, billing, multi-branch, reporting |
| Telematics / IoT | 2–3 | Ingestion, device mgmt, time-series, alerts, pay-per-use |
| Integrations | 1–2 | Exact/SAP connectors, public API, webhooks |
| Frontend / Mobile | 2–3 | Back-office web, portal, storefront, iOS+Android |
| Platform / DevOps / QA | 1–2 | Infra, CI/CD, observability, security |
| Product / Design | 1–2 | Domain modeling, UX of the planning board, roadmap |

Plus domain expertise in **rental operations + EU accounting/tax** — without it, the billing and
ERP-integration modules will be wrong in expensive ways.

---

## 7. Top risks & how to de-risk

1. **Underestimating billing correctness** → highest test coverage, property-based tests, a finance SME,
   golden-file scenarios from real contracts.
2. **Building telematics from scratch** → integrate an existing provider unless it's your moat.
3. **Retrofitting multi-branch/tenancy** → design it in from Phase 0 (RLS, `organization_id` everywhere).
4. **Double-booking bugs** → enforce at the DB with `tstzrange` exclusion constraints, not app code.
5. **ERP connector underscoping** → treat Exact and SAP as separate funded workstreams with specialists.
6. **Mobile cost surprise** → start with one platform + React Native; add the second only when validated.

---

## 8. Build-vs-buy cheat sheet

| Subsystem | Recommendation |
|---|---|
| Rental core, scheduling, invoicing | **Build** — this is your product. |
| Telematics device + ingestion | **Buy/integrate** unless it's your strategic differentiator. |
| Payment processing | **Buy** (Stripe/Adyen/Mollie). |
| E-signature | **Buy** (DocuSign/Signhost). |
| Maps/geocoding/routing | **Buy** (Google/Mapbox). |
| Accounting | **Integrate** (Exact/SAP) — never reimplement the ledger. |
| Auth | **Buy/host** (Keycloak/Auth0). |

---

## 9. Bottom line

- A **rental MVP** is genuinely achievable in **3–5 months with 2–3 engineers**.
- A **competitive rental product** is **~9–15 months with a small team**.
- **"All of AMS.rent," including the telematics moat and Exact/SAP integration, is a 2–3 year,
  ~10–17 person-year, multi-disciplinary program.** The telematics, pay-per-use, and ERP-integration
  subsystems are where most clones die — buy or integrate them rather than rebuild, and the project
  becomes dramatically more tractable.
