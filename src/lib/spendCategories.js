// Shared spend-tracker categories for Order Hub + Purchasing (was duplicated
// verbatim in both). Each key maps to a REAL P&L spend field (via the GL bridge)
// AND a real budget line `budget_<key>` written by the workbook import — so the
// burndown reads the approved budget, not a fabricated % of GFS. No `pctGFS`.
//
// `cogs_ec_other` was dropped: it had no P&L line and no budget line — pure
// fabrication with neither a spend source nor a budget to grade against.
export const SPEND_CATEGORIES = [
  { key: 'cogs_equipment',   label: 'Onsite Equipment' },
  { key: 'cogs_supplies',    label: 'Onsite Supplies' },
  { key: 'cogs_cleaning',    label: 'Cleaning Supplies & Chemicals' },
  { key: 'cogs_paper',       label: 'Paper Products' },
  { key: 'cogs_maintenance', label: 'Onsite Other' },
]
