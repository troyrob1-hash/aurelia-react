import { useState, useEffect, useRef, useCallback } from 'react'

export default function BarcodeScanner({ items, onScan, onClose }) {
  const [mode, setMode] = useState('camera') // 'camera' | 'manual'
  const [manualCode, setManualCode] = useState('')
  const [lastScanned, setLastScanned] = useState(null)
  const [error, setError] = useState(null)
  const scannerRef = useRef(null)
  const html5QrRef = useRef(null)
  const hiddenInputRef = useRef(null)

  // Build SKU lookup map
  const skuMap = useRef({})
  useEffect(() => {
    const map = {}
    items.forEach(item => {
      if (item.sku) {
        // Store with and without leading zeros
        const clean = String(item.sku).trim()
        map[clean] = item
        // Also try without leading zeros
        const noLeading = clean.replace(/^0+/, '')
        if (noLeading) map[noLeading] = item
      }
    })
    skuMap.current = map
  }, [items])

  const handleBarcode = useCallback((code) => {
    const clean = String(code).trim()
    if (!clean) return

    // Try exact match first, then without leading zeros
    let match = skuMap.current[clean]
    if (!match) match = skuMap.current[clean.replace(/^0+/, '')]
    // Try partial match — some scanners add/remove check digits
    if (!match) {
      const keys = Object.keys(skuMap.current)
      const partial = keys.find(k => k.includes(clean) || clean.includes(k))
      if (partial) match = skuMap.current[partial]
    }

    if (match) {
      setLastScanned({ code: clean, item: match, found: true })
      onScan(match)
    } else {
      setLastScanned({ code: clean, item: null, found: false })
    }
  }, [onScan])

  // Camera scanner
  useEffect(() => {
    if (mode !== 'camera') return
    let scanner = null

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode')
        scanner = new Html5Qrcode('barcode-reader')
        html5QrRef.current = scanner

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 280, height: 120 },
            aspectRatio: 1.777,
            formatsToSupport: [
              0,  // QR_CODE
              2,  // UPC_A
              3,  // UPC_E
              4,  // EAN_8
              5,  // EAN_13
              10, // CODE_128
              9,  // CODE_39
            ],
          },
          (decodedText) => {
            handleBarcode(decodedText)
          },
          () => {} // ignore errors during scanning
        )
        setError(null)
      } catch (err) {
        console.error('Scanner error:', err)
        setError('Camera access denied or not available. Use manual entry or a Bluetooth scanner.')
      }
    }

    startScanner()

    return () => {
      if (scanner && scanner.isScanning) {
        scanner.stop().catch(() => {})
      }
    }
  }, [mode, handleBarcode])

  // Bluetooth scanner listener — captures rapid keystrokes ending in Enter
  const keystrokeBuffer = useRef('')
  const keystrokeTimer = useRef(null)

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in a real input
      if (e.target.tagName === 'INPUT' && e.target !== hiddenInputRef.current) return

      if (e.key === 'Enter') {
        if (keystrokeBuffer.current.length >= 4) {
          handleBarcode(keystrokeBuffer.current)
        }
        keystrokeBuffer.current = ''
        e.preventDefault()
        return
      }

      if (e.key.length === 1) {
        keystrokeBuffer.current += e.key
        clearTimeout(keystrokeTimer.current)
        keystrokeTimer.current = setTimeout(() => {
          keystrokeBuffer.current = ''
        }, 100) // Reset if keystrokes are too slow (not a scanner)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleBarcode])

  const handleManualSubmit = () => {
    if (manualCode.trim()) {
      handleBarcode(manualCode.trim())
      setManualCode('')
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', zIndex: 2900 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        background: '#fff', borderRadius: 16, width: 420, maxWidth: '94vw', zIndex: 3000,
        boxShadow: '0 20px 60px rgba(15,23,42,0.2)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '0.5px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Scan barcode</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8', padding: '0 4px' }}>×</button>
        </div>

        {/* Mode toggle */}
        <div style={{ padding: '12px 20px 0', display: 'flex', gap: 0 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', background: '#f1f5f9', borderRadius: 8, padding: 3,
          }}>
            <button onClick={() => setMode('camera')} style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 500, borderRadius: 6, border: 'none', cursor: 'pointer',
              background: mode === 'camera' ? '#fff' : 'transparent',
              boxShadow: mode === 'camera' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              color: mode === 'camera' ? '#0f172a' : '#64748b',
            }}>Camera</button>
            <button onClick={() => setMode('manual')} style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 500, borderRadius: 6, border: 'none', cursor: 'pointer',
              background: mode === 'manual' ? '#fff' : 'transparent',
              boxShadow: mode === 'manual' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              color: mode === 'manual' ? '#0f172a' : '#64748b',
            }}>Manual / Bluetooth</button>
          </div>
        </div>

        {/* Scanner area */}
        <div style={{ padding: '16px 20px' }}>
          {mode === 'camera' ? (
            <div>
              <div id="barcode-reader" ref={scannerRef} style={{ width: '100%', borderRadius: 8, overflow: 'hidden', background: '#000' }} />
              {error && (
                <p style={{ fontSize: 13, color: '#dc2626', marginTop: 8 }}>{error}</p>
              )}
              <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 8, textAlign: 'center' }}>
                Point camera at a barcode. Bluetooth scanners also work in the background.
              </p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                Type or scan a barcode number. Bluetooth scanners will auto-detect.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  ref={hiddenInputRef}
                  type="text"
                  value={manualCode}
                  onChange={e => setManualCode(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleManualSubmit() }}
                  placeholder="Enter barcode number..."
                  autoFocus
                  style={{ flex: 1, padding: '10px 12px', fontSize: 14, border: '1px solid #e2e8f0', borderRadius: 8 }}
                />
                <button onClick={handleManualSubmit} style={{
                  padding: '10px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff',
                  border: 'none', borderRadius: 8, cursor: 'pointer',
                }}>Look up</button>
              </div>
            </div>
          )}

          {/* Last scan result */}
          {lastScanned && (
            <div style={{
              marginTop: 14, padding: '12px 14px', borderRadius: 10,
              background: lastScanned.found ? '#f0fdf4' : '#fef2f2',
              border: '1px solid ' + (lastScanned.found ? '#bbf7d0' : '#fecaca'),
            }}>
              {lastScanned.found ? (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#166534' }}>
                    Found: {lastScanned.item.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#4ade80', marginTop: 2 }}>
                    {lastScanned.code} · Scrolled to item
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#991b1b' }}>
                    No match found
                  </div>
                  <div style={{ fontSize: 12, color: '#f87171', marginTop: 2 }}>
                    Barcode: {lastScanned.code}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
