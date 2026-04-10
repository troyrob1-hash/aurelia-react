import { Upload, X } from 'lucide-react'

/**
 * Full-screen drop zone overlay that appears when a file is being dragged
 * over the parent container. Renders a centered card with an upload icon,
 * custom text, and an explicit close button so users can dismiss it if
 * they change their mind or if the overlay gets stuck.
 *
 * Usage:
 *   <div {...dragHandlers}>
 *     ...page content...
 *     {isDragging && (
 *       <DropZoneOverlay
 *         title="Drop sales file here"
 *         subtitle="Accepts .xlsx, .xls, or .csv"
 *         onClose={dismiss}
 *       />
 *     )}
 *   </div>
 */
export default function DropZoneOverlay({
  title = 'Drop file here',
  subtitle = '',
  onClose,
}) {
  return (
    <div
      // Block pointer events from reaching the page behind the overlay,
      // but NOT drag events — those need to pass through so dragleave
      // fires on the parent when the user drags back out.
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        animation: 'dropzoneFadeIn 0.15s ease-out',
        pointerEvents: 'none',  // let drag events pass through to parent
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: '48px 56px',
          border: '3px dashed #1D9E75',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          maxWidth: 440,
          position: 'relative',
          pointerEvents: 'auto',  // re-enable for the card itself (for close button)
        }}
      >
        {onClose && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            aria-label="Dismiss drop zone"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: 6,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            <X size={16} />
          </button>
        )}

        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: '#f0fdf4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#1D9E75',
            marginBottom: 8,
          }}
        >
          <Upload size={24} />
        </div>

        <div
          style={{
            fontSize: 17,
            fontWeight: 600,
            color: '#0f172a',
            textAlign: 'center',
          }}
        >
          {title}
        </div>

        {subtitle && (
          <div
            style={{
              fontSize: 12,
              color: '#64748b',
              textAlign: 'center',
            }}
          >
            {subtitle}
          </div>
        )}

        <div
          style={{
            fontSize: 11,
            color: '#cbd5e1',
            marginTop: 8,
          }}
        >
          Press Esc to cancel
        </div>
      </div>

      <style>{`
        @keyframes dropzoneFadeIn {
          from { opacity: 0 }
          to { opacity: 1 }
        }
      `}</style>
    </div>
  )
}
