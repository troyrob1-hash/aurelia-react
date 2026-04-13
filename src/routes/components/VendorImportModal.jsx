// src/routes/components/VendorImportModal.jsx
// Vendor catalog CSV/XLSX import. Upload a file, auto-detect columns,
// let the user correct the mapping, preview, commit to Firestore.
//
// Writes to:
//   tenants/{orgId}/inventoryCatalog/{itemId}  — one doc per product
//   tenants/{orgId}/vendors/{vendorSlug}       — one doc per distinct vendor
//
// Strategy: upsert by SKU (matches on existing doc.id === slug of SKU),
// and any existing items for this vendor NOT in the new import are marked
// inactive (soft-delete) rather than hard-deleted.

import { useState, useCallback, useMemo, useRef } from 'react'
import { X, Upload, CheckCircle, AlertTriangle, FileText } from 'lucide-react'
import * as XLSX from 'xlsx'
import { collection, writeBatch, doc, getDocs, query, where, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import styles from './VendorImportModal.module.css'

// ─── Field definitions: the canonical fields we map TO ─────────────────────
// Each field has a list of header name patterns we'll try to auto-match.
const CANONICAL_FIELDS = [
  {
    key:  'sku',
    label: 'SKU / Item Code',
    required: true,
    patterns: [/^sku$/i, /item\s*code/i, /item\s*#/i, /product\s*(number|#|code)/i, /^code$/i],
  },
  {
    key:  'name',
    label: 'Product Name',
    required: true,
    patterns: [/^name$/i, /product\s*name/i, /description/i, /item\s*description/i, /^item$/i, /^product$/i],
  },
  {
    key:  'unitCost',
    label: 'Unit Cost',
    required: true,
    patterns: [/unit\s*(cost|price)/i, /case\s*price/i, /^price$/i, /^cost$/i, /your\s*price/i, /net\s*price/i],
  },
  {
    key:  'packSize',
    label: 'Pack Size',
    required: false,
    patterns: [/pack\s*size/i, /^pack$/i, /case\s*pack/i, /pack\s*qty/i, /^size$/i],
  },
  {
    key:  'category',
    label: 'Category',
    required: false,
    patterns: [/category/i, /^cat$/i, /department/i, /^class$/i],
  },
  {
    key:  'brand',
    label: 'Brand',
    required: false,
    patterns: [/^brand$/i, /manufacturer/i, /^mfr$/i],
  },
]

// Slugify a vendor name for use as a doc ID
function vendorSlug(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// Slugify an SKU for use as a doc ID (preserves case-insensitive uniqueness)
function skuToDocId(sku) {
  return (sku || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// Auto-detect which source column maps to which canonical field
function autoDetectMapping(headers) {
  const mapping = {}
  for (const field of CANONICAL_FIELDS) {
    for (const header of headers) {
      if (field.patterns.some(rx => rx.test(header))) {
        if (!mapping[field.key]) mapping[field.key] = header
      }
    }
  }
  return mapping
}

// Parse a currency string like "$12.34" or "12.34" or "1,234.56" to a number
function parsePrice(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const s = String(v).replace(/[^0-9.-]/g, '')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function VendorImportModal({ orgId, onClose, onSuccess }) {
  const [step, setStep] = useState('upload')  // upload → map → preview → committing → done
  const [vendorName, setVendorName] = useState('')
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState([])
  const [headers, setHeaders] = useState([])
  const [mapping, setMapping] = useState({})
  const [commitResult, setCommitResult] = useState(null)
  const [error, setError] = useState(null)
  const [committing, setCommitting] = useState(false)
  const fileInputRef = useRef(null)

  // Handle file selection
  const handleFile = useCallback(async (f) => {
    setError(null)
    if (!f) return
    setFile(f)
    try {
      const buf = await f.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const firstSheet = wb.SheetNames[0]
      const sheet = wb.Sheets[firstSheet]
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
      if (rows.length === 0) {
        setError('File appears to be empty.')
        return
      }
      const hdrs = Object.keys(rows[0])
      setHeaders(hdrs)
      setRawRows(rows)
      setMapping(autoDetectMapping(hdrs))
      // Guess vendor name from filename (e.g. "sysco-price-list.xlsx" → "sysco")
      if (!vendorName) {
        const guess = f.name.replace(/\.[^.]+$/, '').split(/[-_\s]/)[0]
        setVendorName(guess.charAt(0).toUpperCase() + guess.slice(1))
      }
      setStep('map')
    } catch (e) {
      console.error('Parse error:', e)
      setError('Failed to parse file: ' + e.message)
    }
  }, [vendorName])

  // Validated mapping → parsed items
  const parsedItems = useMemo(() => {
    if (!rawRows.length || !mapping.sku || !mapping.name) return []
    return rawRows.map(row => ({
      sku:      String(row[mapping.sku] ?? '').trim(),
      name:     String(row[mapping.name] ?? '').trim(),
      unitCost: parsePrice(row[mapping.unitCost]),
      packSize: String(row[mapping.packSize] ?? '').trim(),
      category: String(row[mapping.category] ?? '').trim(),
      brand:    String(row[mapping.brand] ?? '').trim(),
    })).filter(i => i.sku && i.name)  // drop rows with no SKU or name
  }, [rawRows, mapping])

  const validForPreview = mapping.sku && mapping.name && mapping.unitCost && vendorName.trim() && parsedItems.length > 0

  // Commit to Firestore
  const commit = useCallback(async () => {
    if (!orgId || !vendorName.trim() || parsedItems.length === 0) return
    setCommitting(true)
    setError(null)
    try {
      const vSlug = vendorSlug(vendorName)
      if (!vSlug) throw new Error('Invalid vendor name')

      // Step 1: fetch existing items for this vendor so we can soft-delete
      // any that aren't in the new import.
      const existingSnap = await getDocs(query(
        collection(db, 'tenants', orgId, 'inventoryCatalog'),
        where('vendorSlug', '==', vSlug)
      ))
      const existingIds = new Set(existingSnap.docs.map(d => d.id))
      const newIds = new Set()

      // Step 2: build batches (Firestore limit 500 ops per batch)
      const batches = []
      let current = writeBatch(db)
      let opCount = 0

      // Upsert vendor doc
      const vendorRef = doc(db, 'tenants', orgId, 'vendors', vSlug)
      current.set(vendorRef, {
        name:      vendorName.trim(),
        slug:      vSlug,
        active:    true,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),  // safe to re-set; merge:true below
      }, { merge: true })
      opCount++

      // Upsert item docs
      for (const item of parsedItems) {
        const docId = `${vSlug}__${skuToDocId(item.sku)}`
        newIds.add(docId)
        const itemRef = doc(db, 'tenants', orgId, 'inventoryCatalog', docId)
        current.set(itemRef, {
          id:         docId,
          sku:        item.sku,
          name:       item.name,
          unitCost:   item.unitCost,
          packSize:   item.packSize,
          category:   item.category || null,
          brand:      item.brand || null,
          vendor:     vendorName.trim(),
          vendorSlug: vSlug,
          active:     true,
          source:     'import',
          updatedAt:  serverTimestamp(),
        }, { merge: true })
        opCount++
        if (opCount >= 450) {
          batches.push(current)
          current = writeBatch(db)
          opCount = 0
        }
      }

      // Soft-delete existing items that weren't in the new import
      let softDeleted = 0
      for (const existingId of existingIds) {
        if (newIds.has(existingId)) continue
        const itemRef = doc(db, 'tenants', orgId, 'inventoryCatalog', existingId)
        current.set(itemRef, { active: false, removedAt: serverTimestamp() }, { merge: true })
        softDeleted++
        opCount++
        if (opCount >= 450) {
          batches.push(current)
          current = writeBatch(db)
          opCount = 0
        }
      }
      if (opCount > 0) batches.push(current)

      // Execute all batches sequentially
      for (const b of batches) {
        await b.commit()
      }

      setCommitResult({
        imported:    parsedItems.length,
        softDeleted: softDeleted,
        vendorName:  vendorName.trim(),
      })
      setStep('done')
      if (onSuccess) onSuccess()
    } catch (e) {
      console.error('Import commit failed:', e)
      setError('Import failed: ' + e.message)
    } finally {
      setCommitting(false)
    }
  }, [orgId, vendorName, parsedItems, onSuccess])

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <h2 className={styles.title}>Import vendor catalog</h2>
            <p className={styles.subtitle}>Upload a price list from Sysco, US Foods, or any vendor</p>
          </div>
          <button className={styles.closeBtn} onClick={onClose}><X size={18}/></button>
        </div>

        {error && (
          <div className={styles.errorBanner}>
            <AlertTriangle size={16}/>
            <span>{error}</span>
          </div>
        )}

        {step === 'upload' && (
          <div className={styles.uploadArea}>
            <div className={styles.vendorField}>
              <label className={styles.fieldLabel}>Vendor name</label>
              <input
                type="text"
                placeholder="e.g. Sysco, US Foods, Vistar"
                value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                className={styles.vendorInput}
              />
            </div>
            <div
              className={styles.dropzone}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add(styles.dragging) }}
              onDragLeave={e => e.currentTarget.classList.remove(styles.dragging)}
              onDrop={e => {
                e.preventDefault()
                e.currentTarget.classList.remove(styles.dragging)
                handleFile(e.dataTransfer.files[0])
              }}
            >
              <Upload size={32}/>
              <div className={styles.dropzoneText}>
                <strong>Click to upload</strong> or drag and drop
              </div>
              <div className={styles.dropzoneSub}>
                Supports .csv, .xlsx, .xls
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              style={{ display: 'none' }}
              onChange={e => handleFile(e.target.files[0])}
            />
          </div>
        )}

        {step === 'map' && (
          <div className={styles.mapArea}>
            <div className={styles.fileBadge}>
              <FileText size={14}/>
              <span>{file?.name}</span>
              <span className={styles.rowCount}>· {rawRows.length} rows</span>
            </div>
            <div className={styles.mapGrid}>
              <div className={styles.mapGridHeader}>Our field</div>
              <div className={styles.mapGridHeader}>Your column</div>
              {CANONICAL_FIELDS.map(field => (
                <div key={field.key} className={styles.mapRow}>
                  <div className={styles.mapFieldLabel}>
                    {field.label}
                    {field.required && <span className={styles.requiredStar}>*</span>}
                  </div>
                  <select
                    value={mapping[field.key] || ''}
                    onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value }))}
                    className={styles.mapSelect}
                  >
                    <option value="">— not mapped —</option>
                    {headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className={styles.actions}>
              <button className={styles.btnSecondary} onClick={() => setStep('upload')}>Back</button>
              <button
                className={styles.btnPrimary}
                disabled={!validForPreview}
                onClick={() => setStep('preview')}
              >
                Preview ({parsedItems.length} items)
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && (
          <div className={styles.previewArea}>
            <div className={styles.previewHeader}>
              <div>
                <strong>{parsedItems.length} items</strong> from <strong>{vendorName}</strong>
              </div>
              <div className={styles.previewSub}>
                Showing first 10 rows. Soft-deletes will remove any existing {vendorName} items not in this file.
              </div>
            </div>
            <div className={styles.previewTable}>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Pack</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedItems.slice(0, 10).map((i, idx) => (
                    <tr key={idx}>
                      <td>{i.sku}</td>
                      <td>{i.name}</td>
                      <td>{i.packSize}</td>
                      <td>${i.unitCost.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.actions}>
              <button className={styles.btnSecondary} onClick={() => setStep('map')}>Back</button>
              <button
                className={styles.btnPrimary}
                disabled={committing}
                onClick={commit}
              >
                {committing ? 'Importing…' : `Import ${parsedItems.length} items`}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && commitResult && (
          <div className={styles.doneArea}>
            <CheckCircle size={48} color="#10b981"/>
            <h3 className={styles.doneTitle}>Import complete</h3>
            <p className={styles.doneSummary}>
              Imported <strong>{commitResult.imported}</strong> items to <strong>{commitResult.vendorName}</strong>
              {commitResult.softDeleted > 0 && (
                <>, soft-deleted <strong>{commitResult.softDeleted}</strong> items no longer in the file</>
              )}
              .
            </p>
            <button className={styles.btnPrimary} onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
