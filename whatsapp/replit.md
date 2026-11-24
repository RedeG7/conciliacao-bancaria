# WhatsApp Disparos

## Overview

A WhatsApp campaign blast tool for Brazilian businesses. Users import a spreadsheet (CSV or XLSX), pick a personalized message template with dynamic fields like `{nome}`, `{valor}`, `{data}`, and send WhatsApp messages contact-by-contact via WhatsApp Web links. Fully in Portuguese.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (artifacts/whatsapp-disparos)
- **API framework**: Express 5 (artifacts/api-server)
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Spreadsheet parsing**: xlsx (client-side)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Features

- **Home Page (public)** — landing page visible before login with hero, how-it-works, features, and CTA sections
- **Dashboard** — overview stats (campaigns, contacts, sent, pending)
- **Campanhas** — create, view, and delete campaigns
- **Nova Campanha** — import CSV/XLSX, pick a template, preview contacts; auto-saves to global contacts DB
- **Detalhe da Campanha** — list contacts, send via WhatsApp Web button, mark as sent
- **Templates** — create/edit/delete message templates with {nome}, {valor}, {data}, etc.
- **Contatos** — global contacts directory with CNPJ, email, company fields; import via spreadsheet or manual entry; search by name/phone/CNPJ
- **Suporte** — support page with WhatsApp link (62992771254), FAQ, and contact info
- **Multi-user system** — super_admin and user roles, campaign ownership per user, block/unblock users
- **User Management** — CPF/CNPJ lookup, create/delete users, profile page for non-admins
- **Campaign Finalization** — irreversible finalize action disables all send buttons
- **PWA** — installable as app on mobile (192/512 icons, manifest, service worker via vite-plugin-pwa)
- **Responsive layout** — hamburger drawer on mobile, sidebar on desktop (md+), all tables scroll horizontally
- **Theme selector** — light/dark/system with localStorage persistence
- **Collapsible sidebar** — toggle with PanelLeftClose/Open icons, localStorage persistence
- **Campaign filters** — status pills, date range, name search

## Database Schema

- `templates` — message templates (id, name, body, createdAt)
- `campaigns` — campaign records (id, name, templateId, userId, status, finishedAt, createdAt)
- `contacts` — contacts per campaign (id, campaignId, name, phone, extraFields, status, sentAt, message)
- `global_contacts` — global contacts directory (id, userId, name, phone, cnpj, email, company, extraFields, createdAt)
- `users` — system users (id, username, passwordHash, name, email, cpfCnpj, role, isActive, createdAt)

## API Routes

- `GET/POST /api/templates` — list / create templates
- `PUT/DELETE /api/templates/:id` — update / delete template
- `GET/POST /api/campaigns` — list / create campaigns (POST also saves contacts to global_contacts)
- `GET/DELETE /api/campaigns/:id` — get / delete campaign
- `GET /api/campaigns/:id/contacts` — list campaign contacts
- `PATCH /api/campaigns/:id/contacts/:contactId/sent` — mark contact as sent
- `GET /api/campaigns/stats/summary` — overall stats
- `GET /api/contacts` — list global contacts (with optional ?q= search)
- `POST /api/contacts` — create single contact or bulk import (array)
- `PUT /api/contacts/:id` — update contact
- `DELETE /api/contacts/:id` — delete contact

## Auth Flow

- Unauthenticated users → Home landing page (/) or Login page (/login)
- Authenticated users → Dashboard at / (inside Layout)
- Support number: 5562992771254

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
