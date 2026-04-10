import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Drag-and-drop file upload hook with correct enter/leave counting and
 * proper dismissal support (escape key, programmatic dismiss, child element
 * hover safety).
 *
 * Usage:
 *   const { isDragging, dragHandlers, dismiss } = useDragDropUpload({
 *     acceptedExtensions: ['.xlsx', '.xls', '.csv'],
 *     onFile: async (file) => { ... },
 *     onInvalidFile: (file) => toast.error('...'),
 *   })
 *
 *   <div {...dragHandlers}>
 *     ...page content...
 *     {isDragging && <DropZoneOverlay onClose={dismiss} />}
 *   </div>
 *
 * Why the counter pattern:
 *   The native `dragleave` event fires whenever the cursor crosses any child
 *   element's boundary, even if you're still inside the parent container. A
 *   naive `setIsDragging(false)` in dragleave causes flickering and stuck
 *   overlays. The fix is to count enter/leave events and only consider the
 *   user "truly left" when the counter returns to zero.
 */
export function useDragDropUpload({
  acceptedExtensions = [],
  onFile,
  onInvalidFile,
} = {}) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const dismiss = useCallback(() => {
    dragCounter.current = 0
    setIsDragging(false)
  }, [])

  // Escape key dismisses the overlay
  useEffect(() => {
    if (!isDragging) return
    const handleKey = (e) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isDragging, dismiss])

  // Safety: if the drag ends anywhere on the window (including outside the
  // drop zone), reset the counter. This catches the case where the user drags
  // a file in, then drags it back out of the window entirely.
  useEffect(() => {
    if (!isDragging) return
    const handleWindowDragEnd = () => dismiss()
    window.addEventListener('dragend', handleWindowDragEnd)
    window.addEventListener('drop', handleWindowDragEnd)
    return () => {
      window.removeEventListener('dragend', handleWindowDragEnd)
      window.removeEventListener('drop', handleWindowDragEnd)
    }
  }, [isDragging, dismiss])

  const dragHandlers = {
    onDragEnter: (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current += 1
      if (dragCounter.current === 1) setIsDragging(true)
    },
    onDragOver: (e) => {
      e.preventDefault()
      e.stopPropagation()
    },
    onDragLeave: (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current -= 1
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setIsDragging(false)
      }
    },
    onDrop: async (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)

      const file = e.dataTransfer.files?.[0]
      if (!file) return

      // Validate extension if list provided
      if (acceptedExtensions.length > 0) {
        const lowerName = file.name.toLowerCase()
        const isValid = acceptedExtensions.some(ext => lowerName.endsWith(ext))
        if (!isValid) {
          onInvalidFile?.(file)
          return
        }
      }

      await onFile?.(file)
    },
  }

  return { isDragging, dragHandlers, dismiss }
}
